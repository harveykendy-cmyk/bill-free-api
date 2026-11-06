require('dotenv').config();
const express = require('express'), helmet = require('helmet'), cors = require('cors'), rate = require('express-rate-limit');
const { Pool } = require('pg'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken'), crypto = require('crypto');
const { DATABASE_URL, JWT_SECRET, PAYSTACK_SECRET, PORT = 3000, WITHDRAW_FEE_PCT = '1', PREFERRED_BANK = 'wema-bank', APP_ORIGIN } = process.env;
if (!DATABASE_URL || !JWT_SECRET) throw new Error('Set DATABASE_URL and JWT_SECRET');
const DEMO_MODE = process.env.DEMO_MODE !== 'false';

const db = new Pool({ connectionString: DATABASE_URL });
const app = express();
app.set('trust proxy', 1);
// Inline onclick handlers are used by the bundled frontend; scripts themselves must still come from our own origin.
app.use(helmet({ contentSecurityPolicy: { useDefaults: true, directives: { 'script-src-attr': ["'unsafe-inline'"] } } }));
app.use(cors({ origin: APP_ORIGIN || false }));
app.use(express.json({ limit: '50kb', verify: (req, _res, buf) => { req.raw = buf; } }));
app.use(express.static('public'));
// Public preview mode: allow the website and health check, but block account creation,
// sign-in, money movement, lending, savings contributions and other state changes.
app.use((req, res, next) => {
  if (DEMO_MODE && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.path !== '/contact') {
    return res.status(503).json({ error: 'This public preview is read-only. Financial and account actions are disabled.' });
  }
  next();
});

const naira = k => Number(k) / 100;
const toKobo = n => Math.round(Number(n) * 100);
const sign = uid => jwt.sign({ uid }, JWT_SECRET, { expiresIn: '12h' });
const auth = (req, res, next) => { try { req.uid = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET).uid; next(); } catch { res.status(401).json({ error: 'Please log in again' }); } };
const wrap = f => (req, res) => f(req, res).catch(e => {
  if (e.status) return res.status(e.status).json({ error: e.message });
  if (e.message === 'INSUFFICIENT') return res.status(400).json({ error: 'Insufficient balance' });
  console.error(e); res.status(500).json({ error: 'Something went wrong' });
});
const ps = async (path, method = 'GET', body) => {
  if (!PAYSTACK_SECRET) throw new Error('Paystack is disabled in demo mode');
  const r = await fetch('https://api.paystack.co' + path, { method, headers: { Authorization: 'Bearer ' + PAYSTACK_SECRET, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await r.json(); if (!j.status) throw new Error(j.message || 'Paystack error'); return j.data;
};
const tx = async f => { const c = await db.connect(); try { await c.query('begin'); const r = await f(c); await c.query('commit'); return r; } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); } };

// Every money movement goes through here: one ledger row + one balance change, atomically, once per ref.
async function post(c, uid, type, kobo, label, ref) {
  const ins = await c.query('insert into ledger(user_id,type,amount_kobo,label,ref) values($1,$2,$3,$4,$5) on conflict(ref) do nothing returning id', [uid, type, kobo, label, ref]);
  if (!ins.rowCount) return false; // already processed
  const sql = type === 'credit'
    ? 'update users set balance_kobo = balance_kobo + $1 where id = $2 returning balance_kobo'
    : 'update users set balance_kobo = balance_kobo - $1 where id = $2 and balance_kobo >= $1 returning balance_kobo';
  if (!(await c.query(sql, [kobo, uid])).rowCount) throw new Error('INSUFFICIENT');
  return true;
}

// ---------- Auth ----------
app.use('/auth', rate({ windowMs: 15 * 60 * 1000, limit: 30 }));
app.post('/auth/signup', wrap(async (req, res) => {
  const { name, email, phone, password } = req.body || {};
  if (!name || name.trim().length < 3 || !/^\S+@\S+\.\S+$/.test(email || '') || !/^0[789][01]\d{8}$/.test(phone || '') || !password || password.length < 8)
    return res.status(400).json({ error: 'Check your details. Password needs 8+ characters.' });
  let u;
  try { u = (await db.query('insert into users(name,email,phone,pw_hash) values($1,$2,$3,$4) returning id', [name.trim(), email.toLowerCase(), phone, await bcrypt.hash(password, 12)])).rows[0]; }
  catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'An account with this phone or email already exists' }); throw e; }
  const [first, ...rest] = name.trim().split(/\s+/);
  try { await ps('/dedicated_account/assign', 'POST', { email: email.toLowerCase(), first_name: first, last_name: rest.join(' ') || first, phone: '+234' + phone.slice(1), preferred_bank: PREFERRED_BANK, country: 'NG' }); }
  catch (e) { console.error('DVA request failed:', e.message); } // account number arrives later via webhook
  res.json({ token: sign(u.id) });
}));
app.post('/auth/login', wrap(async (req, res) => {
  const { phone, password } = req.body || {};
  const u = (await db.query('select * from users where phone=$1', [phone || ''])).rows[0];
  const bad = () => res.status(401).json({ error: 'Phone number or password is incorrect' });
  if (!u) return bad();
  if (u.locked_until && u.locked_until > new Date()) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  if (!(await bcrypt.compare(password || '', u.pw_hash))) {
    await db.query("update users set failed_logins=failed_logins+1, locked_until = case when failed_logins+1 >= 5 then now() + interval '15 minutes' end where id=$1", [u.id]);
    return bad();
  }
  await db.query('update users set failed_logins=0, locked_until=null where id=$1', [u.id]);
  res.json({ token: sign(u.id) });
}));

// ---------- Account ----------
app.get('/me', auth, wrap(async (req, res) => {
  const u = (await db.query('select name,email,phone,account_number,account_bank,balance_kobo from users where id=$1', [req.uid])).rows[0];
  res.json({ id: req.uid, name: u.name, email: u.email, phone: u.phone, accountNumber: u.account_number, bank: u.account_bank, balance: naira(u.balance_kobo), trust: (await trustFor([req.uid]))[req.uid] });
}));
app.get('/transactions', auth, wrap(async (req, res) => {
  const r = await db.query('select type,amount_kobo,label,created_at from ledger where user_id=$1 order by id desc limit 50', [req.uid]);
  res.json(r.rows.map(x => ({ type: x.type, amount: naira(x.amount_kobo), label: x.label, at: x.created_at })));
}));

// ---------- Helpers for groups, chat and loans ----------
const E = (status, msg) => Object.assign(new Error(msg), { status });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
app.param('id', (_req, res, next, v) => UUID.test(v) ? next() : res.status(400).json({ error: 'Bad id' }));
const member = async (c, gid, uid) => { if (!(await c.query('select 1 from group_members where group_id=$1 and user_id=$2', [gid, uid])).rowCount) throw E(403, 'You are not a member of this group'); };

// ---------- Trust score: computed from real activity in the ledger, loans and groups ----------
const LEVEL = x => x >= 85 ? 'Gold' : x >= 70 ? 'Trusted' : x >= 55 ? 'Building' : 'New member';
async function trustFor(ids) {
  const out = {}; if (!ids.length) return out;
  const q = sql => db.query(sql, [ids]);
  const [sv, wk, rp, gr, hp] = await Promise.all([
    q("select user_id, count(*)::int n from ledger where ref like 'grp:%' and user_id = any($1::uuid[]) group by user_id"),
    q("select user_id, date_trunc('week', created_at) w from ledger where ref like 'grp:%' and user_id = any($1::uuid[]) group by 1,2 order by 2 desc"),
    q("select borrower_id user_id, count(*)::int n from loans where status='repaid' and borrower_id = any($1::uuid[]) group by 1"),
    q('select user_id, count(*)::int n from groups where user_id = any($1::uuid[]) group by 1'),
    q("select user_id, count(*)::int n from ledger where ref like 'help:%' and type='debit' and user_id = any($1::uuid[]) group by 1")]);
  const cnt = r => Object.fromEntries(r.rows.map(x => [x.user_id, x.n])), S = cnt(sv), R = cnt(rp), G = cnt(gr), H = cnt(hp), W = {};
  wk.rows.forEach(x => (W[x.user_id] = W[x.user_id] || []).push(new Date(x.w).getTime()));
  for (const id of ids) {
    const ws = W[id] || []; let streak = 0;
    if (ws.length && (Date.now() - ws[0]) / 6048e5 <= 2) { streak = 1; for (let i = 1; i < ws.length && Math.round((ws[i - 1] - ws[i]) / 6048e5) === 1; i++) streak++; }
    const s = S[id] || 0, r = R[id] || 0, g = G[id] || 0, h = H[id] || 0;
    const score = Math.min(100, 40 + Math.min(s * 3, 30) + Math.min(streak * 4, 20) + Math.min(r * 10, 10));
    out[id] = { score, level: LEVEL(score), badges: [s >= 1 && 'First save', streak >= 4 && `${streak}-week streak`, r >= 1 && 'Paid back a loan', g >= 1 && 'Group builder', h >= 1 && 'Helped a member'].filter(Boolean) };
  }
  return out;
}
const say = (c, conv, uid, body) => c.query('insert into messages(conv,sender,body) values($1,$2,$3)', [conv, uid, body]);
const money = k => '₦' + naira(k).toLocaleString('en-NG');

// ---------- Savings groups (types, invite codes, payout draw) ----------
const GTYPES = ['ajo', 'wedding', 'burial', 'worship', 'market', 'estate', 'school', 'rent', 'festive'];
const newCode = async () => { for (;;) { const c = crypto.randomBytes(3).toString('hex').toUpperCase(); if (!(await db.query('select 1 from groups where code=$1', [c])).rowCount) return c; } };
app.get('/groups', auth, wrap(async (req, res) => {
  const r = await db.query(`select g.*, to_char(g.deadline,'YYYY-MM-DD') deadline_s, (select json_agg(json_build_object('id',u.id,'name',u.name,'phone',u.phone,'contributed',m.contributed_kobo/100.0) order by m.joined_at)
      from group_members m join users u on u.id=m.user_id where m.group_id=g.id) members
    from groups g join group_members me on me.group_id=g.id and me.user_id=$1 order by g.created_at desc`, [req.uid]);
  const T = await trustFor([...new Set(r.rows.flatMap(g => g.members.map(m => m.id)))]);
  res.json(r.rows.map(g => ({ id: g.id, name: g.name, type: g.type, amount: naira(g.amount_kobo), freq: g.freq, target: naira(g.target_kobo), deadline: g.deadline_s, code: g.code, saved: naira(g.saved_kobo), ownerId: g.user_id,
    members: g.members.map(m => ({ id: m.id, name: m.name, contributed: m.contributed, trust: T[m.id].score, phone: g.user_id === req.uid ? m.phone : undefined })),
    order: (g.payout_order || []).map(id => g.members.find(m => m.id === id)?.name).filter(Boolean) })));
}));
app.post('/groups', auth, wrap(async (req, res) => {
  const { name, amount, freq = 'weekly', target = 0, type = 'ajo', deadline = '' } = req.body || {};
  if (!name || !(amount > 0) || !['daily', 'weekly', 'monthly', 'one-time'].includes(freq) || !GTYPES.includes(type) || (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline))) throw E(400, 'Invalid group');
  const code = await newCode();
  const id = await tx(async c => {
    const g = (await c.query('insert into groups(user_id,name,amount_kobo,freq,target_kobo,type,deadline,code) values($1,$2,$3,$4,$5,$6,$7,$8) returning id', [req.uid, name.trim().slice(0, 80), toKobo(amount), freq, toKobo(target || 0), type, deadline || null, code])).rows[0].id;
    await c.query('insert into group_members(group_id,user_id) values($1,$2)', [g, req.uid]);
    return g;
  });
  res.json({ id, code });
}));
app.post('/groups/join', auth, rate({ windowMs: 60 * 60 * 1000, limit: 20 }), wrap(async (req, res) => {
  const g = (await db.query('select id, name from groups where code=$1', [String(req.body?.code || '').trim().toUpperCase()])).rows[0];
  if (!g) throw E(404, 'No group found with that code');
  await db.query('insert into group_members(group_id,user_id) values($1,$2) on conflict do nothing', [g.id, req.uid]);
  res.json({ ok: true, name: g.name });
}));
app.post('/groups/:id/draw', auth, wrap(async (req, res) => { // fair payout draw: shuffled on the server, then locked
  await tx(async c => {
    const g = (await c.query('select * from groups where id=$1 for update', [req.params.id])).rows[0];
    if (!g || g.user_id !== req.uid) throw E(403, 'Only the group admin can run the draw');
    if (g.payout_order) throw E(400, 'The payout order has already been drawn');
    const ms = (await c.query('select user_id from group_members where group_id=$1', [g.id])).rows.map(x => x.user_id);
    if (ms.length < 2) throw E(400, 'Add at least 2 members first');
    for (let i = ms.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [ms[i], ms[j]] = [ms[j], ms[i]]; }
    await c.query('update groups set payout_order=$1 where id=$2', [JSON.stringify(ms), g.id]);
    await say(c, 'g:' + g.id, req.uid, '🎲 The payout order has been drawn and locked. Check the Groups tab.');
  });
  res.json({ ok: true });
}));
app.post('/groups/:id/members', auth, wrap(async (req, res) => { // admin adds a registered user by phone
  const g = (await db.query('select user_id from groups where id=$1', [req.params.id])).rows[0];
  if (!g || g.user_id !== req.uid) throw E(403, 'Only the group admin can add members');
  const u = (await db.query('select id from users where phone=$1', [String(req.body?.phone || '')])).rows[0];
  if (!u) throw E(404, 'That person has not signed up on Bill-Free yet');
  await db.query('insert into group_members(group_id,user_id) values($1,$2) on conflict do nothing', [req.params.id, u.id]);
  res.json({ ok: true });
}));
app.post('/groups/:id/contribute', auth, wrap(async (req, res) => {
  await tx(async c => {
    const g = (await c.query('select g.* from groups g join group_members m on m.group_id=g.id and m.user_id=$2 where g.id=$1 for update of g', [req.params.id, req.uid])).rows[0];
    if (!g) throw E(404, 'Group not found');
    await post(c, req.uid, 'debit', g.amount_kobo, 'Saved to ' + g.name, 'grp:' + crypto.randomUUID());
    await c.query('update groups set saved_kobo = saved_kobo + $1 where id=$2', [g.amount_kobo, g.id]);
    await c.query('update group_members set contributed_kobo = contributed_kobo + $1 where group_id=$2 and user_id=$3', [g.amount_kobo, g.id, req.uid]);
  });
  res.json({ ok: true });
}));

// ---------- Chat: group rooms + one-to-one between people who share a group ----------
// conv = "g:<groupId>"  or  "d:<userIdA>:<userIdB>" (ids sorted). Clients poll with ?after=<lastMessageId>.
async function chatAccess(conv, uid) {
  const [t, a, b] = String(conv).split(':');
  if (t === 'g' && UUID.test(a || '')) return member(db, a, uid);
  if (t === 'd' && UUID.test(a || '') && UUID.test(b || '') && a < b && (a === uid || b === uid)) {
    const o = a === uid ? b : a;
    if ((await db.query('select 1 from group_members x join group_members y on x.group_id=y.group_id where x.user_id=$1 and y.user_id=$2 limit 1', [uid, o])).rowCount) return;
    throw E(403, 'You can only chat with members of your groups');
  }
  throw E(400, 'Bad conversation');
}
app.get('/chats', auth, wrap(async (req, res) => {
  const gs = await db.query('select g.id, g.name from groups g join group_members m on m.group_id=g.id where m.user_id=$1', [req.uid]);
  const ms = await db.query('select distinct u.id, u.name from group_members x join group_members y on x.group_id=y.group_id join users u on u.id=y.user_id where x.user_id=$1 and y.user_id<>$1', [req.uid]);
  res.json([...gs.rows.map(g => ({ conv: 'g:' + g.id, title: g.name, type: 'group' })), ...ms.rows.map(u => ({ conv: 'd:' + [req.uid, u.id].sort().join(':'), title: u.name, type: 'direct' }))]);
}));
app.get('/chats/:conv/messages', auth, wrap(async (req, res) => {
  await chatAccess(req.params.conv, req.uid);
  const r = await db.query('select m.id, m.sender, u.name, m.body, m.created_at from messages m join users u on u.id=m.sender where m.conv=$1 and m.id>$2 order by m.id desc limit 100', [req.params.conv, parseInt(req.query.after) || 0]);
  res.json(r.rows.reverse().map(m => ({ id: Number(m.id), senderId: m.sender, sender: m.name, body: m.body, at: m.created_at, mine: m.sender === req.uid })));
}));
app.post('/chats/:conv/messages', auth, rate({ windowMs: 60 * 1000, limit: 60 }), wrap(async (req, res) => {
  const body = String(req.body?.body || '').trim();
  if (!body || body.length > 1000) throw E(400, 'Message must be 1 to 1000 characters');
  await chatAccess(req.params.conv, req.uid);
  const r = await db.query('insert into messages(conv,sender,body) values($1,$2,$3) returning id', [req.params.conv, req.uid, body]);
  res.json({ id: Number(r.rows[0].id) });
}));

// ---------- Pooled loans: up to 3 group members fund one member; funds held until fully funded ----------
const RATES = [5, 10, 15], WEEKS = [4, 8, 12];
const dueOf = l => Math.round(Number(l.amount_kobo) * (100 + l.rate_pct) / 100);
const lockLoan = async (c, id) => (await c.query('select * from loans where id=$1 for update', [id])).rows[0];
const nameOf = async (c, id) => (await c.query('select name from users where id=$1', [id])).rows[0].name;
app.get('/loans', auth, wrap(async (req, res) => {
  const r = await db.query(`select l.*, u.name borrower_name, g.name group_name,
      coalesce((select json_agg(json_build_object('id',x.user_id,'name',lu.name,'amount',x.amount_kobo/100.0)) from loan_lenders x join users lu on lu.id=x.user_id where x.loan_id=l.id),'[]') lenders
    from loans l join users u on u.id=l.borrower_id join groups g on g.id=l.group_id
    where l.status<>'cancelled' and l.group_id in (select group_id from group_members where user_id=$1) order by l.created_at desc`, [req.uid]);
  const T = await trustFor([...new Set(r.rows.map(l => l.borrower_id))]);
  res.json(r.rows.map(l => ({ borrowerTrust: T[l.borrower_id].score, id: l.id, groupId: l.group_id, group: l.group_name, borrowerId: l.borrower_id, borrower: l.borrower_name, amount: naira(l.amount_kobo), ratePct: l.rate_pct, weeks: l.weeks, purpose: l.purpose,
    funded: naira(l.funded_kobo), repaid: naira(l.repaid_kobo), totalDue: naira(dueOf(l)), installment: naira(Math.ceil(dueOf(l) / l.weeks)), status: l.status, lenders: l.lenders })));
}));
app.post('/loans', auth, wrap(async (req, res) => {
  const { group_id, amount, weeks, rate_pct, purpose = '' } = req.body || {};
  if (!UUID.test(group_id || '') || !(amount >= 1000) || !WEEKS.includes(weeks) || !RATES.includes(rate_pct)) throw E(400, 'Invalid loan request');
  await member(db, group_id, req.uid);
  try { res.json({ id: (await db.query('insert into loans(group_id,borrower_id,amount_kobo,rate_pct,weeks,purpose) values($1,$2,$3,$4,$5,$6) returning id', [group_id, req.uid, toKobo(amount), rate_pct, weeks, String(purpose).slice(0, 200)])).rows[0].id }); }
  catch (e) { if (e.code === '23505') throw E(409, 'Finish your current loan first'); throw e; }
}));
app.post('/loans/:id/lend', auth, wrap(async (req, res) => {
  const kobo = toKobo(req.body?.amount); if (!(kobo > 0)) throw E(400, 'Invalid amount');
  await tx(async c => {
    const l = await lockLoan(c, req.params.id);
    if (!l || l.status !== 'open') throw E(400, 'This loan is not open');
    if (l.borrower_id === req.uid) throw E(400, 'You cannot fund your own loan');
    await member(c, l.group_id, req.uid);
    const rem = Number(l.amount_kobo) - Number(l.funded_kobo);
    const ls = (await c.query('select user_id from loan_lenders where loan_id=$1', [l.id])).rows;
    const count = ls.length + (ls.some(x => x.user_id === req.uid) ? 0 : 1);
    if (kobo > rem) throw E(400, 'That is more than is still needed');
    if (count > 3) throw E(400, 'This loan already has 3 lenders');
    if (count === 3 && kobo < rem) throw E(400, 'With 3 lenders, the last one must cover the full remaining amount');
    await post(c, req.uid, 'debit', kobo, `Loan to ${await nameOf(c, l.borrower_id)} (held until fully funded)`, `loan:${l.id}:lend:${crypto.randomUUID()}`);
    await c.query('insert into loan_lenders(loan_id,user_id,amount_kobo) values($1,$2,$3) on conflict(loan_id,user_id) do update set amount_kobo = loan_lenders.amount_kobo + excluded.amount_kobo', [l.id, req.uid, kobo]);
    const funded = Number(l.funded_kobo) + kobo;
    if (funded >= Number(l.amount_kobo)) {
      await post(c, l.borrower_id, 'credit', funded, 'Pooled loan received', `loan:${l.id}:disburse`);
      await c.query("update loans set funded_kobo=$1, status='active' where id=$2", [funded, l.id]);
    } else await c.query('update loans set funded_kobo=$1 where id=$2', [funded, l.id]);
  });
  res.json({ ok: true });
}));
app.post('/loans/:id/cancel', auth, wrap(async (req, res) => {
  await tx(async c => {
    const l = await lockLoan(c, req.params.id);
    if (!l || l.borrower_id !== req.uid || l.status !== 'open') throw E(400, 'Only your own open request can be cancelled');
    for (const x of (await c.query('select user_id, amount_kobo from loan_lenders where loan_id=$1', [l.id])).rows)
      await post(c, x.user_id, 'credit', x.amount_kobo, 'Loan funding refunded', `loan:${l.id}:refund:${x.user_id}`);
    await c.query("update loans set status='cancelled' where id=$1", [l.id]);
  });
  res.json({ ok: true });
}));
app.post('/loans/:id/repay', auth, wrap(async (req, res) => {
  await tx(async c => {
    const l = await lockLoan(c, req.params.id);
    if (!l || l.borrower_id !== req.uid || l.status !== 'active') throw E(400, 'No active loan to repay');
    const due = dueOf(l), pay = Math.min(Math.ceil(due / l.weeks), due - Number(l.repaid_kobo)), run = crypto.randomUUID();
    await post(c, req.uid, 'debit', pay, 'Loan repayment', `loan:${l.id}:repay:${run}`);
    const ls = (await c.query('select user_id, amount_kobo from loan_lenders where loan_id=$1 order by user_id', [l.id])).rows;
    let left = pay; // each lender gets their share; the last lender absorbs rounding so totals always match
    for (let i = 0; i < ls.length; i++) {
      const share = i === ls.length - 1 ? left : Math.floor(pay * Number(ls[i].amount_kobo) / Number(l.amount_kobo));
      left -= share;
      if (share > 0) await post(c, ls[i].user_id, 'credit', share, 'Loan repayment received', `loan:${l.id}:repay:${run}:${ls[i].user_id}`);
    }
    const repaid = Number(l.repaid_kobo) + pay;
    await c.query('update loans set repaid_kobo=$1, status=$2 where id=$3', [repaid, repaid >= due ? 'repaid' : 'active', l.id]);
  });
  res.json({ ok: true });
}));

// ---------- Withdrawals (Paystack Transfers) ----------
app.get('/banks/resolve', auth, wrap(async (req, res) => {
  try { const d = await ps(`/bank/resolve?account_number=${encodeURIComponent(req.query.account_number)}&bank_code=${encodeURIComponent(req.query.bank_code)}`); res.json({ name: d.account_name }); }
  catch { res.status(400).json({ error: 'Could not verify that account' }); }
}));
app.post('/withdraw', auth, rate({ windowMs: 60 * 60 * 1000, limit: 10 }), wrap(async (req, res) => {
  const { amount, bank_code, account_number, account_name, password } = req.body || {};
  const u = (await db.query('select pw_hash from users where id=$1', [req.uid])).rows[0];
  if (!(await bcrypt.compare(password || '', u.pw_hash))) return res.status(401).json({ error: 'Incorrect password' });
  if (!(amount >= 100) || !/^\d{10}$/.test(account_number || '') || !bank_code) return res.status(400).json({ error: 'Invalid withdrawal details' });
  const kobo = toKobo(amount), fee = Math.ceil(kobo * Number(WITHDRAW_FEE_PCT) / 100), ref = crypto.randomUUID();
  await tx(c => post(c, req.uid, 'debit', kobo + fee, `Withdrawal to ${account_number}`, 'wd:' + ref)); // debit first, then pay out
  try {
    const rcp = await ps('/transferrecipient', 'POST', { type: 'nuban', name: account_name || 'Bill-Free user', account_number, bank_code, currency: 'NGN' });
    await ps('/transfer', 'POST', { source: 'balance', amount: kobo, recipient: rcp.recipient_code, reference: ref, reason: 'Bill-Free withdrawal' });
    res.json({ ok: true, fee: naira(fee) });
  } catch (e) {
    await tx(c => post(c, req.uid, 'credit', kobo + fee, 'Withdrawal refunded', 'refund:' + ref));
    res.status(502).json({ error: 'Transfer could not be started. You were not charged.' });
  }
}));

// ---------- Paystack webhook: this is what credits balances ----------
app.post('/webhooks/paystack', wrap(async (req, res) => {
  const sig = crypto.createHmac('sha512', PAYSTACK_SECRET).update(req.raw || '').digest('hex');
  if (sig !== req.headers['x-paystack-signature']) return res.sendStatus(401);
  const { event, data } = req.body;
  const email = (data?.customer?.email || '').toLowerCase();
  if (event === 'dedicatedaccount.assign.success') {
    const a = data.dedicated_account;
    await db.query('update users set account_number=$1, account_bank=$2 where email=$3', [a.account_number, a.bank?.name, email]);
  } else if (event === 'charge.success' && data.channel === 'dedicated_nuban') {
    // Verify against Paystack before crediting.
    const v = await ps('/transaction/verify/' + encodeURIComponent(data.reference));
    if (v.status === 'success') {
      const u = (await db.query('select id from users where email=$1', [email])).rows[0];
      if (u) await tx(c => post(c, u.id, 'credit', v.amount, 'Deposit to your account', 'ps:' + v.reference));
    }
  } else if (event === 'transfer.failed' || event === 'transfer.reversed') {
    const w = (await db.query('select user_id, amount_kobo from ledger where ref=$1', ['wd:' + data.reference])).rows[0];
    if (w) await tx(c => post(c, w.user_id, 'credit', w.amount_kobo, 'Withdrawal refunded', 'refund:' + data.reference));
  }
  res.sendStatus(200);
}));

// ---------- Shared bills (diesel, water, security, light): one person pays, members send their share ----------
const BILLS = ['Generator diesel', 'Water', 'Security', 'Light bill', 'Other'];
app.get('/bills', auth, wrap(async (req, res) => {
  const r = await db.query(`select b.*, u.name creator_name, g.name group_name,
      (select count(*) from group_members where group_id=b.group_id)::int members,
      (select count(*) from bill_payments where bill_id=b.id)::int paid,
      exists(select 1 from bill_payments where bill_id=b.id and user_id=$1) i_paid
    from bills b join users u on u.id=b.creator_id join groups g on g.id=b.group_id
    where b.group_id in (select group_id from group_members where user_id=$1) order by b.created_at desc limit 50`, [req.uid]);
  res.json(r.rows.map(b => ({ id: b.id, group: b.group_name, name: b.name, total: naira(b.total_kobo), share: naira(b.share_kobo), by: b.creator_name, mine: b.creator_id === req.uid, members: b.members, paid: b.paid, iPaid: b.i_paid })));
}));
app.post('/bills', auth, wrap(async (req, res) => {
  const { group_id, name, total } = req.body || {}, kobo = toKobo(total);
  if (!UUID.test(group_id || '') || !BILLS.includes(name) || !(kobo >= 10000)) throw E(400, 'Invalid bill');
  await tx(async c => {
    await member(c, group_id, req.uid);
    const n = (await c.query('select count(*)::int n from group_members where group_id=$1', [group_id])).rows[0].n, share = Math.ceil(kobo / n);
    const b = (await c.query('insert into bills(group_id,creator_id,name,total_kobo,share_kobo) values($1,$2,$3,$4,$5) returning id', [group_id, req.uid, name, kobo, share])).rows[0];
    await c.query('insert into bill_payments(bill_id,user_id) values($1,$2)', [b.id, req.uid]);
    await say(c, 'g:' + group_id, req.uid, `🧾 ${name}: ${money(kobo)} split ${n} ways. Your share is ${money(share)}. See the Pay tab.`);
  });
  res.json({ ok: true });
}));
app.post('/bills/:id/pay', auth, wrap(async (req, res) => {
  await tx(async c => {
    const b = (await c.query('select * from bills where id=$1', [req.params.id])).rows[0];
    if (!b) throw E(404, 'Bill not found');
    await member(c, b.group_id, req.uid);
    if (!(await c.query('insert into bill_payments(bill_id,user_id) values($1,$2) on conflict do nothing returning 1', [b.id, req.uid])).rowCount) throw E(400, 'You have already paid this bill');
    await post(c, req.uid, 'debit', b.share_kobo, b.name + ' (my share)', `bill:${b.id}:${req.uid}`);
    await post(c, b.creator_id, 'credit', b.share_kobo, b.name + ' share received', `billin:${b.id}:${req.uid}`);
  });
  res.json({ ok: true });
}));

// ---------- Urgent help: a gift from group members, not a loan ----------
app.get('/help', auth, wrap(async (req, res) => {
  const r = await db.query(`select h.*, u.name requester, (select count(*) from help_gifts where help_id=h.id)::int givers from help_requests h join users u on u.id=h.user_id
    where h.group_id in (select group_id from group_members where user_id=$1) order by h.created_at desc limit 50`, [req.uid]);
  const T = await trustFor([...new Set(r.rows.map(h => h.user_id))]);
  res.json(r.rows.map(h => ({ id: h.id, requesterId: h.user_id, requester: h.requester, trust: T[h.user_id].score, amount: naira(h.amount_kobo), got: naira(h.got_kobo), reason: h.reason, status: h.status, givers: h.givers })));
}));
app.post('/help', auth, wrap(async (req, res) => {
  const { group_id, amount, reason } = req.body || {}, kobo = toKobo(amount), why = String(reason || '').trim().slice(0, 120);
  if (!UUID.test(group_id || '') || !(kobo >= 50000) || !why) throw E(400, 'Enter at least ₦500 and say what happened');
  await tx(async c => {
    await member(c, group_id, req.uid);
    await c.query('insert into help_requests(group_id,user_id,amount_kobo,reason) values($1,$2,$3,$4)', [group_id, req.uid, kobo, why]);
    await say(c, 'g:' + group_id, req.uid, `🚨 Urgent help needed: ${money(kobo)}. ${why}. See the Help tab.`);
  });
  res.json({ ok: true });
}));
app.post('/help/:id/give', auth, wrap(async (req, res) => {
  const kobo = toKobo(req.body?.amount); if (!(kobo > 0)) throw E(400, 'Invalid amount');
  await tx(async c => {
    const h = (await c.query('select * from help_requests where id=$1 for update', [req.params.id])).rows[0];
    if (!h || h.status !== 'open') throw E(400, 'This request is closed');
    if (h.user_id === req.uid) throw E(400, 'You cannot give to your own request');
    await member(c, h.group_id, req.uid);
    const run = crypto.randomUUID();
    await post(c, req.uid, 'debit', kobo, 'Gift to ' + (await nameOf(c, h.user_id)) + ' (urgent help)', `help:${h.id}:${run}`);
    await post(c, h.user_id, 'credit', kobo, 'Help received from ' + (await nameOf(c, req.uid)), `helpin:${h.id}:${run}`);
    await c.query('insert into help_gifts(help_id,user_id,amount_kobo) values($1,$2,$3) on conflict(help_id,user_id) do update set amount_kobo = help_gifts.amount_kobo + excluded.amount_kobo', [h.id, req.uid, kobo]);
    const got = Number(h.got_kobo) + kobo;
    await c.query('update help_requests set got_kobo=$1, status=$2 where id=$3', [got, got >= Number(h.amount_kobo) ? 'closed' : 'open', h.id]);
  });
  res.json({ ok: true });
}));
app.post('/help/:id/close', auth, wrap(async (req, res) => {
  if (!(await db.query("update help_requests set status='closed' where id=$1 and user_id=$2 returning 1", [req.params.id, req.uid])).rowCount) throw E(404, 'Request not found');
  res.json({ ok: true });
}));

app.post('/contact', rate({ windowMs: 60 * 60 * 1000, limit: 5 }), wrap(async (req, res) => {
  const { name, email, message } = req.body || {};
  if (!name || !/^\S+@\S+\.\S+$/.test(email || '') || !message || message.length < 5 || message.length > 2000) throw E(400, 'Please fill in your name, a valid email and a message');
  await db.query('insert into contact_messages(name,email,message) values($1,$2,$3)', [String(name).slice(0, 100), String(email).slice(0, 200), message]);
  res.json({ ok: true });
}));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log('Bill-Free API on :' + PORT));
