const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const N = n => '₦' + Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const normP = p => { p = String(p).replace(/\D/g, ''); return p.startsWith('234') ? '0' + p.slice(3) : p; };
const BANKS = [['Access Bank','044'],['Fidelity Bank','070'],['First Bank','011'],['FCMB','214'],['GTBank','058'],['Kuda','50211'],['Moniepoint','50515'],['Opay','999992'],['PalmPay','999991'],['Polaris Bank','076'],['Stanbic IBTC','221'],['Sterling Bank','232'],['UBA','033'],['Union Bank','032'],['Wema Bank','035'],['Zenith Bank','057']];
let token = null; try { token = localStorage.getItem('bf_token'); } catch (e) {}
let S = { me: null, tx: [], bills: [], help: [], groups: [], loans: [], chats: [], conv: null, msgs: [], lastId: 0, hide: false, wd: false, wname: '' };
let tab = 'home', amode = 'signup', timer = null;

async function api(path, method = 'GET', body) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch (e) {}
  if (r.status === 401 && token && !path.startsWith('/auth')) { logout(); throw new Error('Please log in again'); }
  if (!r.ok) throw new Error(j.error || 'Something went wrong');
  return j;
}
const toast = (m, bad) => { const t = $('toast'); t.textContent = m; t.className = 'toast show' + (bad ? ' bad' : ''); clearTimeout(toast.h); toast.h = setTimeout(() => t.className = 'toast', 3500); };
const run = async f => { try { await f(); } catch (e) { toast(e.message, 1); } };
const amt = q => { const v = parseFloat(String(prompt(q) || '').replace(/,/g, '')); return v > 0 ? v : 0; };

function render() {
  $('nav').innerHTML = token && S.me ? `${langSel()}<span style="margin:0 10px">${t('hello')}, ${esc(S.me.name.split(' ')[0])}</span><button class="g" onclick="logout()">Log out</button>` : pubNav();
  $('app').className = token && S.me ? 'w' : 'w wide';
  $('app').innerHTML = token && S.me ? dash() : pubView();
  const cb = $('cb'); if (cb) cb.scrollTop = cb.scrollHeight;
}
function logout() { token = null; S.me = null; clearInterval(timer); try { localStorage.removeItem('bf_token'); } catch (e) {} location.hash = '#login'; render(); }
async function enter(t) { token = t; history.replaceState(null, '', location.pathname); try { localStorage.setItem('bf_token', t); } catch (e) {} S.me = await api('/me'); await go('home'); joinPending(); }
async function boot() { if (!token) return render(); try { S.me = await api('/me'); await go('home'); } catch (e) { render(); } }

/* ---------- Auth ---------- */
function auth() {
  const su = pg() !== 'login';
  return `<h1>${su ? 'Open your Bill-Free account' : 'Welcome back'}</h1><div class="mu">${su ? 'Get your own account number and start saving in minutes.' : 'Log in to see your balance and savings.'}</div>
  <div class="card">${su ? `<label>Full name</label><input id="nm" autocomplete="name" placeholder="Ada Obi"><label>Email</label><input id="em" type="email" autocomplete="email" placeholder="ada@email.com">` : ''}
  <label>Phone number</label><input id="ph" inputmode="tel" autocomplete="tel" placeholder="08012345678">
  <label>Password ${su ? '(8+ characters)' : ''}</label><input id="pw" type="password" autocomplete="${su ? 'new-password' : 'current-password'}" onkeydown="if(event.key==='Enter')${su ? 'signup()' : 'login()'}">
  <div class="err" id="er"></div><button class="p" style="width:100%" onclick="${su ? 'signup()' : 'login()'}">${su ? 'Create account' : 'Log in'}</button>
  <p class="mu" style="text-align:center;margin:14px 0 0">${su ? 'Already have an account?' : 'New to Bill-Free?'} <a href="#${su ? 'login' : 'signup'}" style="color:var(--pr);font-weight:600">${su ? 'Log in' : 'Sign up'}</a></p></div>`;
}
async function signup() {
  const er = m => $('er').textContent = m, body = { name: $('nm').value.trim(), email: $('em').value.trim(), phone: normP($('ph').value), password: $('pw').value };
  if (body.name.length < 3) return er('Enter your full name.');
  if (!/^\S+@\S+\.\S+$/.test(body.email)) return er('Enter a valid email.');
  if (!/^0[789][01]\d{8}$/.test(body.phone)) return er('Enter a valid Nigerian phone number.');
  if (body.password.length < 8) return er('Password must be at least 8 characters.');
  try { await enter((await api('/auth/signup', 'POST', body)).token); } catch (e) { er(e.message); }
}
async function login() {
  try { await enter((await api('/auth/login', 'POST', { phone: normP($('ph').value), password: $('pw').value })).token); } catch (e) { $('er').textContent = e.message; }
}

/* ---------- Navigation and data ---------- */
async function go(t) {
  tab = t; clearInterval(timer);
  await run(async () => {
    if (t === 'home') { [S.me, S.tx] = await Promise.all([api('/me'), api('/transactions')]); timer = setInterval(refreshMe, 10000); }
    if (t === 'grp') S.groups = await api('/groups');
    if (t === 'pay') [S.bills, S.groups] = await Promise.all([api('/bills'), api('/groups')]);
    if (t === 'help') [S.help, S.groups] = await Promise.all([api('/help'), api('/groups')]);
    if (t === 'loan') [S.loans, S.groups] = await Promise.all([api('/loans'), api('/groups')]);
    if (t === 'chat') {
      S.chats = await api('/chats'); if (!S.chats.find(c => c.conv === S.conv)) S.conv = S.chats[0]?.conv || null;
      S.msgs = []; S.lastId = 0; await pull(); timer = setInterval(() => run(pull), 3000);
    }
  });
  render();
}
async function refreshMe() {
  try { const m = await api('/me'); if (m.balance !== S.me.balance || m.accountNumber !== S.me.accountNumber) { S.me = m; S.tx = await api('/transactions'); if (tab === 'home' && !S.wd) render(); } } catch (e) {}
}
function dash() {
  const T = ['home', 'grp', 'chat', 'loan', 'pay', 'help'].map(k => [k, t(k)]);
  return `<div class="tabs">${T.map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" onclick="go('${k}')">${l}</button>`).join('')}</div>` + ({ home, grp: groups, chat, loan: loans, pay: payTab, help: helpTab }[tab])();
}

/* ---------- Home ---------- */
function home() {
  const m = S.me;
  return `<div class="card bal"><div class="row"><span class="lbl">${t('bal')}</span><button class="s" onclick="S.hide=!S.hide;render()">${S.hide ? 'Show' : 'Hide'}</button></div>
  <div class="big">${S.hide ? '₦ ••••••' : N(m.balance)}</div>
  <div class="acct"><div class="lbl">Your Bill-Free account${m.bank ? ' · ' + esc(m.bank) : ''}</div>
  ${m.accountNumber ? `<div class="row"><b>${esc(m.accountNumber)}</b><button class="s" onclick="copyA()">Copy</button></div><div style="font-size:12px;opacity:.8">${esc(m.name.toUpperCase())}</div>`
    : `<div class="row"><span>Setting up your account number…</span><button class="s" onclick="go('home')">Refresh</button></div>`}</div>
  <div class="mu" style="color:#fff;opacity:.85;margin-top:10px">To add money, transfer to this account number from any bank app. It appears here automatically.</div>
  <div style="margin-top:12px"><button style="width:100%" onclick="S.wd=!S.wd;S.wname='';render()">${S.wd ? 'Close' : 'Withdraw to bank'}</button></div></div>`
  + (S.wd ? wdForm() : '') +
  `<div class="card"><h2>Recent transactions</h2>${S.tx.length ? `<table>${S.tx.slice(0, 20).map(x => `<tr><td>${esc(x.label)}<div class="mu">${new Date(x.at).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}</div></td><td class="${x.type === 'credit' ? 'cr' : 'db'}">${x.type === 'credit' ? '+' : '−'}${N(x.amount)}</td></tr>`).join('')}</table>` : '<div class="mu">No transactions yet.</div>'}</div>`+trustCard()+secCard();
}
function copyA() { try { navigator.clipboard.writeText(S.me.accountNumber); toast('Account number copied'); } catch (e) { prompt('Copy:', S.me.accountNumber); } }
function wdForm() {
  return `<div class="card"><h2>Withdraw to your bank</h2><label>Bank</label><select id="wb" onchange="S.wname=''">${BANKS.map(([n, c]) => `<option value="${c}">${n}</option>`).join('')}</select>
  <label>Account number</label><input id="wa" inputmode="numeric" maxlength="10" placeholder="0123456789" oninput="S.wname=''">
  <button class="s" onclick="resolveA()">Verify account</button><div style="margin:8px 0;font-weight:600;color:var(--ok)" id="wn">${esc(S.wname)}</div>
  <label>Amount (₦)</label><input id="wm" type="number" inputmode="numeric" placeholder="5000"><label>Your password</label><input id="wp" type="password" autocomplete="current-password">
  <div class="mu" style="margin-bottom:10px">A small service fee applies. You will be told the exact fee after the transfer starts.</div>
  <button class="p" style="width:100%" onclick="withdraw()">Withdraw</button></div>`;
}
const resolveA = () => run(async () => { const r = await api(`/banks/resolve?account_number=${encodeURIComponent($('wa').value)}&bank_code=${encodeURIComponent($('wb').value)}`); S.wname = r.name; $('wn').textContent = r.name; });
const withdraw = () => run(async () => {
  if (!S.wname) return toast('Verify the account first', 1);
  const r = await api('/withdraw', 'POST', { amount: +$('wm').value, bank_code: $('wb').value, account_number: $('wa').value, account_name: S.wname, password: $('wp').value });
  toast('Withdrawal started. Fee: ' + N(r.fee)); S.wd = false; await go('home');
});

/* ---------- Groups ---------- */
const TYPES = [['ajo', '🔄', 'Ajo / Esusu'], ['wedding', '💍', 'Wedding / Aso-ebi'], ['burial', '🕊️', 'Burial / Family support'], ['worship', '⛪', 'Church / Mosque dues'], ['market', '🏪', 'Market association'], ['estate', '🏘️', 'Estate / compound levy'], ['school', '🎓', 'School fees'], ['rent', '🏠', 'Rent'], ['festive', '🎄', 'Christmas / Sallah']];
const tIcon = k => (TYPES.find(x => x[0] === k) || TYPES[0])[1];
function groups() {
  let h = `<div class="card"><h2>Start a group</h2><label>What is it for?</label><select id="gt0">${TYPES.map(x => `<option value="${x[0]}">${x[1]} ${x[2]}</option>`).join('')}</select>
  <div class="grid"><div><label>Group name</label><input id="gn" placeholder="e.g. Ada &amp; Tunde’s Wedding"></div><div><label>Amount each (₦)</label><input id="ga" type="number" inputmode="numeric" placeholder="5000"></div></div>
  <div class="grid"><div><label>How often</label><select id="gf"><option>weekly</option><option>monthly</option><option>daily</option><option>one-time</option></select></div><div><label>Target (₦, optional)</label><input id="gt" type="number" inputmode="numeric" placeholder="100000"></div></div>
  <label>Deadline (optional)</label><input id="gd" type="date"><button class="p" style="width:100%" onclick="mkg()">Create group</button>
  <div class="row" style="margin-top:12px"><input id="jc" placeholder="Have an invite code?" style="margin:0;text-transform:uppercase"><button onclick="joinCode($('jc').value)">Join</button></div></div>`;
  if (!S.groups.length) return h + '<div class="mu">You are not in any group yet.</div>';
  S.groups.forEach(g => {
    const pc = g.target ? Math.min(100, g.saved / g.target * 100) : 0, dl = g.deadline ? Math.ceil((new Date(g.deadline + 'T23:59:59') - Date.now()) / 864e5) : null, own = g.ownerId === S.me.id;
    const inv = encodeURIComponent(`Join “${g.name}” on Bill-Free. Invite code: ${g.code}. Open ${location.origin}/#join-${g.code}`);
    const lz = own ? g.members.filter(m => m.id !== S.me.id && !(m.contributed > 0) && m.phone) : [];
    h += `<div class="card"><div class="row"><h2 style="margin:0">${tIcon(g.type)} ${esc(g.name)}</h2><span class="pill">${esc(g.freq)}</span></div>
    ${dl !== null ? `<div class="mu">${dl >= 0 ? dl + ' days left' : 'Deadline passed'}</div>` : ''}
    <div class="mu" style="margin-top:6px">Group savings</div><div style="font-size:24px;font-weight:800">${N(g.saved)}</div>
    ${g.target ? `<div class="bar"><i style="width:${pc}%"></i></div><div class="mu">${pc.toFixed(0)}% of ${N(g.target)} target</div>` : ''}
    <div style="margin:10px 0">${g.members.map(m => `<span class="chip">${esc(m.name)}${m.id === g.ownerId ? ' (admin)' : ''} · ${N(m.contributed)} · 🛡️${m.trust}</span>`).join('')}</div>
    ${lz.length ? `<div class="mu rm" style="margin-bottom:8px">Not saved yet: ${lz.map(m => `<a target="_blank" rel="noopener" href="https://wa.me/234${m.phone.slice(1)}?text=${encodeURIComponent(`Hello ${m.name}, a friendly reminder to save ${N(g.amount)} to ${g.name} on Bill-Free. Thank you!`)}">${esc(m.name)} 💬</a>`).join('')}</div>` : ''}
    <button class="p" style="width:100%" onclick="pay('${g.id}')">Save ${N(g.amount)} from balance</button>
    <div class="grid" style="margin-top:8px"><a class="btn" style="text-align:center" target="_blank" rel="noopener" href="https://wa.me/?text=${inv}">Invite on WhatsApp</a><button onclick="copyC('${g.code}')">Copy code ${g.code}</button></div>
    ${own ? `<button style="width:100%;margin-top:8px" onclick="addm('${g.id}')">+ Add member by phone</button>` : ''}
    ${g.type === 'ajo' ? (g.order.length ? `<div style="margin-top:10px"><div class="lbl" style="color:var(--mu)">Payout order (locked)</div><ol style="margin:6px 0;padding-left:20px">${g.order.map(n => `<li>${esc(n)}</li>`).join('')}</ol></div>` : (own && g.members.length > 1 ? `<div style="margin-top:10px"><button style="width:100%" onclick="draw('${g.id}')">🎲 Run the payout draw</button><div id="dr${g.id}" style="text-align:center;font-weight:700;margin-top:6px"></div></div>` : '')) : ''}</div>`;
  });
  return h;
}
const mkg = () => run(async () => { await api('/groups', 'POST', { name: $('gn').value, type: $('gt0').value, amount: +$('ga').value, freq: $('gf').value, target: +$('gt').value || 0, deadline: $('gd').value }); toast('Group created'); await go('grp'); });
const pay = id => run(async () => { await api(`/groups/${id}/contribute`, 'POST'); toast('Saved'); await go('grp'); });
const addm = id => run(async () => { const p = normP(prompt('Phone number of the member to add:') || ''); if (!p) return; await api(`/groups/${id}/members`, 'POST', { phone: p }); toast('Member added'); await go('grp'); });
const joinCode = c => run(async () => { const r = await api('/groups/join', 'POST', { code: c }); toast('You joined ' + r.name); await go('grp'); });
let PEND = '';
function joinPending() { if (PEND) { const c = PEND; PEND = ''; joinCode(c); } }
const copyC = c => { try { navigator.clipboard.writeText(c); toast('Invite code copied: ' + c); } catch (e) { prompt('Copy:', c); } };
function draw(id) { // the order is shuffled on the server and locked; the spinner is just for show
  const g = S.groups.find(x => x.id === id), el = $('dr' + id); let n = 0;
  const iv = setInterval(() => { el.textContent = '🎲 ' + g.members[Math.floor(Math.random() * g.members.length)].name; if (++n > 18) { clearInterval(iv); run(async () => { await api(`/groups/${id}/draw`, 'POST'); await go('grp'); }); } }, 110);
}

/* ---------- Chat ---------- */
function chat() {
  if (!S.chats.length) return '<div class="card"><h2>Chat</h2><div class="mu">Create or join a savings group to chat with its members.</div></div>';
  return `<div class="card"><label>Conversation</label><select onchange="pick(this.value)">${S.chats.map(c => `<option value="${esc(c.conv)}" ${c.conv === S.conv ? 'selected' : ''}>${c.type === 'group' ? '👥 ' + esc(c.title) + ' (group)' : '💬 ' + esc(c.title)}</option>`).join('')}</select>
  <div class="chat" id="cb">${msgsHtml()}</div>
  <div class="row"><input id="mi" maxlength="1000" placeholder="Type a message" onkeydown="if(event.key==='Enter')send()" style="margin:0"><button class="p" onclick="send()">Send</button></div></div>`;
}
const msgsHtml = () => S.msgs.length ? S.msgs.map(m => `<div class="b ${m.mine ? 'me' : ''}">${m.mine ? '' : `<small>${esc(m.sender)}</small>`}${esc(m.body)}<small>${new Date(m.at).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })}</small></div>`).join('') : '<div class="mu">No messages yet. Say hello.</div>';
const paint = () => { const cb = $('cb'); if (cb) { cb.innerHTML = msgsHtml(); cb.scrollTop = cb.scrollHeight; } };
async function pull() {
  if (!S.conv) return; const k = S.conv;
  const ms = await api(`/chats/${encodeURIComponent(k)}/messages?after=${S.lastId}`);
  if (k !== S.conv) return;
  if (ms.length || !S.lastId) { S.msgs.push(...ms); if (ms.length) S.lastId = ms[ms.length - 1].id; paint(); }
}
const pick = v => run(async () => { S.conv = v; S.msgs = []; S.lastId = 0; await pull(); render(); });
const send = () => run(async () => { const i = $('mi'), b = i.value.trim(); if (!b) return; i.value = ''; await api(`/chats/${encodeURIComponent(S.conv)}/messages`, 'POST', { body: b }); await pull(); });

/* ---------- Pooled loans ---------- */
function loans() {
  let h = `<div class="card"><h2>Request a loan from your group</h2>` + (S.groups.length ? `<div class="grid"><div><label>Group</label><select id="lg">${S.groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></div><div><label>Amount (₦)</label><input id="la" type="number" inputmode="numeric" placeholder="50000"></div></div>
  <div class="grid"><div><label>Repay over (weeks)</label><select id="lw"><option>4</option><option>8</option><option>12</option></select></div><div><label>Total interest</label><select id="lr"><option value="5">5%</option><option value="10">10%</option><option value="15">15%</option></select></div></div>
  <label>Purpose</label><input id="lp" maxlength="200" placeholder="e.g. Restock my shop"><button class="p" style="width:100%" onclick="mkLoan()">Post request</button>
  <div class="mu" style="margin-top:8px">Up to 3 group members can fund your loan together. Money only moves once it is fully funded.</div>` : '<div class="mu">Join a savings group first.</div>') + '</div>';
  if (!S.loans.length) h += '<div class="mu">No loan requests in your groups yet.</div>';
  S.loans.forEach(l => {
    const mine = l.borrowerId === S.me.id, st = { open: ['Seeking lenders', 'pw'], active: ['Active', ''], repaid: ['Repaid', ''] }[l.status], inst = Math.min(l.installment, l.totalDue - l.repaid);
    h += `<div class="card"><div class="row"><h2 style="margin:0">${N(l.amount)} · ${esc(l.borrower)} 🛡️${l.borrowerTrust}</h2><span class="pill ${st[1]}">${st[0]}</span></div>
    <div class="mu">${esc(l.purpose || 'No purpose given')} · ${l.weeks} weeks · ${l.ratePct}% interest · total repayable ${N(l.totalDue)}</div>
    <div class="bar"><i style="width:${l.funded / l.amount * 100}%"></i></div><div class="mu">${N(l.funded)} of ${N(l.amount)} funded</div>
    <div style="margin:8px 0">${l.lenders.map(x => `<span class="chip">${esc(x.name)} lent ${N(x.amount)}</span>`).join('') || '<span class="mu">No lenders yet</span>'}</div>
    ${l.status !== 'open' ? `<div class="mu">Repaid ${N(l.repaid)} of ${N(l.totalDue)}</div>` : ''}
    ${l.status === 'open' && !mine ? `<button class="p" style="width:100%;margin-top:8px" onclick="lend('${l.id}',${l.amount - l.funded})">Lend towards this loan</button>` : ''}
    ${l.status === 'open' && mine ? `<button style="width:100%;margin-top:8px" onclick="cancelL('${l.id}')">Cancel request (lenders refunded)</button>` : ''}
    ${l.status === 'active' && mine ? `<button class="p" style="width:100%;margin-top:8px" onclick="repay('${l.id}')">Repay installment (${N(inst)})</button>` : ''}</div>`;
  });
  return h;
}
const mkLoan = () => run(async () => { await api('/loans', 'POST', { group_id: $('lg').value, amount: +$('la').value, weeks: +$('lw').value, rate_pct: +$('lr').value, purpose: $('lp').value }); toast('Loan request posted'); await go('loan'); });
const lend = (id, rem) => run(async () => { const a = amt(`Still needed: ${N(rem)}. How much will you lend (₦)?`); if (!a) return; await api(`/loans/${id}/lend`, 'POST', { amount: a }); toast('Thank you. Your money is held until the loan is fully funded.'); await go('loan'); });
const cancelL = id => run(async () => { if (!confirm('Cancel this request? Any lenders will be refunded.')) return; await api(`/loans/${id}/cancel`, 'POST'); await go('loan'); });
const repay = id => run(async () => { await api(`/loans/${id}/repay`, 'POST'); toast('Repayment made'); await go('loan'); });

/* ---------- Trust, security, languages, bills, help ---------- */
function trustCard() {
  const T = S.me.trust || { score: 40, level: 'New member', badges: [] }, ic = { 'First save': '🌱', 'Paid back a loan': '✅', 'Group builder': '🏗️', 'Helped a member': '❤️' };
  return `<div class="card"><div class="row"><div><div class="lbl" style="color:var(--mu)">Your trust score</div><div class="sc2">${T.score}<span style="font-size:16px;color:var(--mu)"> / 100</span></div></div><span class="pill">${esc(T.level)}</span></div>
  <div class="bar"><i style="width:${T.score}%"></i></div><div style="margin:8px 0">${T.badges.length ? T.badges.map(b => `<span class="chip">${ic[b] || '🔥'} ${esc(b)}</span>`).join('') : '<span class="mu">Save with a group to earn your first badge.</span>'}</div>
  <div class="mu">Save regularly and repay loans on time to raise your score. Group members and lenders can see it.</div></div>`;
}
const secCard = () => `<div class="card"><h2>🔒 Your account security</h2><div class="mu">• You are logged out automatically after 10 minutes of inactivity.<br>• Your password and PIN are never stored as plain text.<br>• Your password is needed to withdraw money.<br>• Too many wrong log-in attempts lock the account for 15 minutes.<br>• Every transaction is kept in your history.<br>Never share your password with anyone, including Bill-Free.</div></div>`;
let idleT; function idle() { clearTimeout(idleT); if (token && S.me) idleT = setTimeout(() => { if (token) { logout(); alert('You were logged out after 10 minutes of inactivity to keep your account safe.'); } }, 600000); }
['click', 'keydown', 'touchstart'].forEach(e => addEventListener(e, idle));
const I = { en: { home: 'Home', grp: 'Groups', chat: 'Chat', loan: 'Loans', pay: 'Pay', help: 'Help', hello: 'Hello', bal: 'Available balance' },
  pcm: { home: 'Home', grp: 'Groups', chat: 'Gist', loan: 'Loan', pay: 'Pay', help: 'Help', hello: 'How far', bal: 'Money wey you get' },
  yo: { home: 'Ilé', grp: 'Ẹgbẹ́', chat: 'Ìjíròrò', loan: 'Awin', pay: 'Sanwó', help: 'Ìrànlọ́wọ́', hello: 'Bawo', bal: 'Owó tó wà' },
  ig: { home: 'Ụlọ', grp: 'Otu', chat: 'Mkparịta', loan: 'Ụgwọ', pay: 'Kwụọ ụgwọ', help: 'Enyemaka', hello: 'Ndewo', bal: 'Ego ị nwere' },
  ha: { home: 'Gida', grp: 'Ƙungiyoyi', chat: 'Hira', loan: 'Rance', pay: 'Biya', help: 'Taimako', hello: 'Sannu', bal: 'Kuɗin da kake da su' } };
let LANG = 'en'; try { LANG = localStorage.getItem('bf_lang') || 'en'; } catch (e) {}
const t = k => (I[LANG] || I.en)[k] || I.en[k];
const langSel = () => `<select class="lang" onchange="setLang(this.value)">${[['en', 'English'], ['pcm', 'Pidgin'], ['yo', 'Yorùbá'], ['ig', 'Igbo'], ['ha', 'Hausa']].map(([k, n]) => `<option value="${k}" ${k === LANG ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
function setLang(v) { LANG = v; try { localStorage.setItem('bf_lang', v); } catch (e) {} render(); }
function payTab() {
  let h = `<div class="card"><h2>Airtime, data and electricity</h2><div class="mu">Coming soon.</div></div>
  <div class="card"><h2>Split a shared bill with your group</h2><div class="mu" style="margin-bottom:8px">Diesel, water, security or light: one person pays, everyone sends their share.</div>` + (S.groups.length ? `<div class="grid"><div><label>Group</label><select id="bg">${S.groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></div><div><label>Bill</label><select id="bn"><option>Generator diesel</option><option>Water</option><option>Security</option><option>Light bill</option><option>Other</option></select></div></div>
  <label>Total amount (₦)</label><input id="bt" type="number" inputmode="numeric" placeholder="40000"><button class="p" style="width:100%" onclick="mkBill()">Split equally</button>` : '<div class="mu">Join a group first.</div>') + '</div>';
  S.bills.forEach(b => { h += `<div class="card"><div class="row"><h2 style="margin:0">🧾 ${esc(b.name)} · ${N(b.total)}</h2><span class="pill ${b.paid < b.members ? 'pw' : ''}">${b.paid}/${b.members} paid</span></div><div class="mu">${esc(b.group)} · collected by ${esc(b.by)} · your share ${N(b.share)}</div><div class="bar"><i style="width:${b.paid / b.members * 100}%"></i></div>${b.mine ? '<div class="mu">You are collecting this bill.</div>' : b.iPaid ? '<div class="mu">You have paid your share. ✓</div>' : `<button class="p" style="width:100%" onclick="payBill('${b.id}')">Pay my share (${N(b.share)})</button>`}</div>`; });
  return h;
}
const mkBill = () => run(async () => { await api('/bills', 'POST', { group_id: $('bg').value, name: $('bn').value, total: +$('bt').value }); toast('Bill shared with your group'); await go('pay'); });
const payBill = id => run(async () => { await api(`/bills/${id}/pay`, 'POST'); toast('Paid'); await go('pay'); });
function helpTab() {
  let h = `<div class="card"><h2>❤️ Ask your group for urgent help</h2>` + (S.groups.length ? `<label>Group</label><select id="eg">${S.groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select><div class="grid"><div><label>Amount needed (₦)</label><input id="ea" type="number" inputmode="numeric" placeholder="30000"></div><div><label>What happened?</label><input id="ew" maxlength="120" placeholder="e.g. Hospital bill"></div></div><button class="p" style="width:100%" onclick="askHelp()">Send request to group</button><div class="mu" style="margin-top:8px">Members give what they can. This is a gift from members, not a loan.</div>` : '<div class="mu">Join a group first.</div>') + '</div>';
  S.help.forEach(e => { const mine = e.requesterId === S.me.id; h += `<div class="card"><div class="row"><h2 style="margin:0">${esc(e.requester)} 🛡️${e.trust}</h2><span class="pill ${e.status === 'open' ? 'pw' : ''}">${e.status === 'open' ? 'Needs help' : 'Closed'}</span></div><div>${esc(e.reason)}</div><div class="bar"><i style="width:${Math.min(100, e.got / e.amount * 100)}%"></i></div><div class="mu">${N(e.got)} of ${N(e.amount)} · ${e.givers} gave</div>${e.status === 'open' ? (mine ? `<button style="width:100%;margin-top:8px" onclick="closeHelp('${e.id}')">Close request</button>` : `<button class="p" style="width:100%;margin-top:8px" onclick="give('${e.id}')">Give</button>`) : ''}</div>`; });
  return h;
}
const askHelp = () => run(async () => { await api('/help', 'POST', { group_id: $('eg').value, amount: +$('ea').value, reason: $('ew').value }); toast('Request sent to your group'); await go('help'); });
const give = id => run(async () => { const a = amt('How much would you like to give (₦)?'); if (!a) return; await api(`/help/${id}/give`, 'POST', { amount: a }); toast('Thank you for helping'); await go('help'); });
const closeHelp = id => run(async () => { await api(`/help/${id}/close`, 'POST'); await go('help'); });
const nigeria = () => `<div class="sec"><h2>Built for how Nigerians save</h2><div class="mu">Not just another wallet.</div></div>
<div class="feat" style="margin-top:12px"><div class="card"><div class="ic">🛡️</div><h2>Trust score</h2><div class="mu">See who pays on time before you lend or add them. Build yours with every save.</div></div>
<div class="card"><div class="ic">🎉</div><h2>Dues for every occasion</h2><div class="mu">Weddings, burials, church and mosque dues, market and estate levies, school fees, rent and festive savings.</div></div>
<div class="card"><div class="ic">🎲</div><h2>Fair payout draw</h2><div class="mu">The ajo order is drawn once, then locked for everyone to see.</div></div>
<div class="card"><div class="ic">💡</div><h2>Shared bills</h2><div class="mu">Split diesel, water, security and light with your compound or family.</div></div>
<div class="card"><div class="ic">❤️</div><h2>Urgent help</h2><div class="mu">Ask your group for help in an emergency and let members give what they can.</div></div>
<div class="card"><div class="ic">🗣️</div><h2>Your language</h2><div class="mu">English, Pidgin, Yorùbá, Igbo and Hausa, plus invites and reminders on WhatsApp.</div></div></div>
<div class="feat"><div class="card"><div class="ic">🔒</div><h2>Protected sign-in</h2><div class="mu">Passwords are stored scrambled, and repeated wrong attempts lock the account.</div></div><div class="card"><div class="ic">⏱️</div><h2>Auto log-out</h2><div class="mu">We sign you out after 10 minutes of inactivity.</div></div><div class="card"><div class="ic">🧾</div><h2>Every naira recorded</h2><div class="mu">Each transaction is kept in your history for you and your group to see.</div></div></div>`;
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

/* ---------- Public site: Home, About, Contact ---------- */
const pg=()=>(location.hash||"#home").slice(1);
function pubNav(){const p=pg(),a=(h,t)=>`<a href="#${h}" class="${p===h?"on":""}">${t}</a>`;return `<nav class="pn">${a("home","Home")}${a("about","About")}${a("contact","Contact")}${a("login","Log in")}<a href="#signup" class="cta">Get started</a>${langSel()}</nav>`}
function pubView(){const p=pg(),au=p==="login"||p==="signup"||p.startsWith("join-");if(p.startsWith("join-"))PEND=p.slice(5).toUpperCase();return (p==="about"?about():p==="contact"?contact():au?`<div class="authw">${PEND&&p.startsWith("join-")?`<div class="card" style="background:var(--ac)"><b>You have been invited to a group.</b><div class="mu">Create your account (or log in) and you will join automatically.</div></div>`:""}<a class="bk" href="#home">← Back to home</a>${auth()}</div>`:landing())+(au?"":foot())}
const foot=()=>`<div class="foot"><div><a href="#home">Home</a><a href="#about">About</a><a href="#contact">Contact</a><a href="#login">Log in</a></div><div>© 2026 Bill-Free. Save together, grow together.</div></div>`;
const cta=()=>`<div class="band"><h2>Ready to save with your people?</h2><div style="opacity:.8">It takes about a minute to open your account.</div><a class="btn" href="#signup" style="color:#0b1f44">Create your free account</a></div>`;
function landing(){return `<div class="hero"><h1>${LANG==="pcm"?"Save together.<br>Borrow from people wey you trust.":"Save together.<br>Borrow from people you trust."}</h1><p>Bill-Free brings your ajo, esusu or cooperative group online. Get your own account number, save with your group, chat, and pool money to lend to each other.</p><a class="btn p" href="#signup">Get started free</a><a class="btn" href="#about">See how it works</a></div>
<div class="feat"><div class="card"><div class="ic">🏦</div><h2>Your own account number</h2><div class="mu">Every member gets a personal account. Money you receive shows up on your balance.</div></div>
<div class="card"><div class="ic">🤝</div><h2>Group savings</h2><div class="mu">Create an ajo or esusu group, set the amount, and see who has saved and who hasn’t.</div></div>
<div class="card"><div class="ic">💬</div><h2>Group and private chat</h2><div class="mu">Talk to the whole group or to one member, right where your savings live.</div></div>
<div class="card"><div class="ic">🧮</div><h2>Pooled loans</h2><div class="mu">Two or three members can combine to fund a loan for one member, with clear terms up front.</div></div></div>
<div class="sec"><h2>How it works</h2><div class="mu">Three steps, no notebooks.</div></div>
<div class="steps" style="margin-top:12px"><div class="card"><h2>Create your account</h2><div class="mu">Sign up with your phone number and get your own account number.</div></div>
<div class="card"><h2>Start or join a group</h2><div class="mu">Invite the people you already save with, or add members by phone number.</div></div>
<div class="card"><h2>Save, chat and lend together</h2><div class="mu">Contribute from your balance, keep the conversation going, and fund each other when it matters.</div></div></div>`+nigeria()+cta()}
function about(){return `<div class="hero" style="padding-bottom:8px"><h1>About Bill-Free</h1><p>Group saving already works across Nigeria. We make it easier to trust, track and grow.</p></div>
<div class="card"><h2>Why we exist</h2><div>Millions of people save through ajo, esusu and cooperatives. These groups work because people trust each other, but notebooks get lost, WhatsApp reminders get ignored, and arguments follow. Bill-Free keeps the trust and removes the friction: every contribution, payout and loan is recorded in one place that everyone in the group can see.</div></div>
<div class="sec"><h2>What we stand for</h2></div>
<div class="feat"><div class="card"><div class="ic">🔍</div><h2>Transparency</h2><div class="mu">Every naira is recorded. Members can always see what was saved, lent and repaid.</div></div>
<div class="card"><div class="ic">🫱🏾‍🫲🏿</div><h2>Trust</h2><div class="mu">Chat and loans happen inside groups you chose to join, among people you know.</div></div>
<div class="card"><div class="ic">🌍</div><h2>Community</h2><div class="mu">We build for traders, workers and families who already help each other grow.</div></div></div>
<div class="two"><div class="card"><h2>How we make money</h2><div class="mu">Plainly: we charge a small fee when you withdraw to your bank. Loans are between members, so we don’t take a cut of the interest, and we don’t lend our own money.</div></div>
<div class="card"><h2>What we don’t do</h2><div class="mu">We don’t sell your data, and we don’t add hidden charges. Your savings and your group’s history belong to you.</div></div></div>`+cta()}
function contact(){return `<div class="hero" style="padding-bottom:8px"><h1>Contact us</h1><p>Questions, feedback or want to bring your group on board? Send us a message.</p></div>
<div class="two"><div class="card" id="cf"><h2>Send a message</h2><label>Your name</label><input id="cn" autocomplete="name"><label>Email</label><input id="ce" type="email" autocomplete="email"><label>Message</label><textarea id="cm" rows="5" maxlength="2000"></textarea><div class="err" id="cr"></div><button class="p" style="width:100%" onclick="sendContact()">Send message</button></div>
<div class="card"><h2>Quick answers</h2><div style="margin-bottom:10px"><b>How do I get my account number?</b><div class="mu">Create your free account. Your personal account number appears on your dashboard.</div></div>
<div style="margin-bottom:10px"><b>How do I add money?</b><div class="mu">Transfer to your account number from any bank app. It shows on your balance.</div></div>
<div><b>How do pooled loans work?</b><div class="mu">One member asks the group for a loan. Up to three members fund it together, and repayments are shared between them.</div></div></div></div>`}
async function sendContact(){
 const b={name:$("cn").value.trim(),email:$("ce").value.trim(),message:$("cm").value.trim()},er=m=>$("cr").textContent=m;
 if(!b.name||!/^\S+@\S+\.\S+$/.test(b.email)||b.message.length<5)return er("Please add your name, a valid email and a message.");
 try{await submitContact(b);$("cf").innerHTML=`<h2>Thank you</h2><div class="mu">We’ve received your message and will reply by email.</div>`}catch(e){er(e.message||"Could not send. Please try again.")}
}
window.addEventListener("hashchange",()=>{if(!LOGGED_IN()){render();window.scrollTo(0,0)}});
const LOGGED_IN=()=>!!(token&&S.me);
const submitContact=b=>api('/contact','POST',b);
const _render = render; render = function () { _render(); idle(); };
boot();
