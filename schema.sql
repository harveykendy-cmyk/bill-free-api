create extension if not exists pgcrypto;
create table if not exists users(
  id uuid primary key default gen_random_uuid(),
  name text not null, email text unique not null, phone text unique not null,
  pw_hash text not null,
  account_number text, account_bank text,
  balance_kobo bigint not null default 0 check (balance_kobo >= 0),
  failed_logins int not null default 0, locked_until timestamptz,
  created_at timestamptz not null default now());
create table if not exists ledger(
  id bigserial primary key,
  user_id uuid not null references users(id),
  type text not null check (type in ('credit','debit')),
  amount_kobo bigint not null check (amount_kobo > 0),
  label text not null,
  ref text unique not null,            -- idempotency key: a payment can never post twice
  created_at timestamptz not null default now());
create index if not exists ledger_user on ledger(user_id, id desc);
create table if not exists groups(
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  name text not null, amount_kobo bigint not null check (amount_kobo > 0),
  freq text not null default 'weekly', target_kobo bigint not null default 0,
  saved_kobo bigint not null default 0, created_at timestamptz not null default now());

-- ===== v2: shared groups, chat, pooled loans =====
create table if not exists group_members(
  group_id uuid not null references groups(id) on delete cascade,
  user_id uuid not null references users(id),
  contributed_kobo bigint not null default 0,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id));
insert into group_members(group_id,user_id,contributed_kobo) select id,user_id,saved_kobo from groups on conflict do nothing;
create table if not exists messages(
  id bigserial primary key,
  conv text not null,                                  -- 'g:<groupId>' or 'd:<userA>:<userB>'
  sender uuid not null references users(id),
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now());
create index if not exists messages_conv on messages(conv, id);
create table if not exists loans(
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id),
  borrower_id uuid not null references users(id),
  amount_kobo bigint not null check (amount_kobo >= 100000),
  rate_pct int not null check (rate_pct in (5,10,15)),
  weeks int not null check (weeks in (4,8,12)),
  purpose text not null default '',
  funded_kobo bigint not null default 0, repaid_kobo bigint not null default 0,
  status text not null default 'open' check (status in ('open','active','repaid','cancelled')),
  created_at timestamptz not null default now());
create unique index if not exists one_live_loan_per_borrower on loans(borrower_id) where status in ('open','active');
create table if not exists loan_lenders(
  loan_id uuid not null references loans(id) on delete cascade,
  user_id uuid not null references users(id),
  amount_kobo bigint not null check (amount_kobo > 0),
  primary key (loan_id, user_id));

-- ===== v3: public contact form =====
create table if not exists contact_messages(
  id bigserial primary key, name text not null, email text not null, message text not null,
  created_at timestamptz not null default now());

-- ===== v4: group types/invites/draw, bills, urgent help =====
alter table groups add column if not exists type text not null default 'ajo';
alter table groups add column if not exists deadline date;
alter table groups add column if not exists code text;
alter table groups add column if not exists payout_order jsonb;
update groups set code = upper(substr(md5(id::text),1,6)) where code is null;
create unique index if not exists groups_code on groups(code);
create table if not exists bills(
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id), creator_id uuid not null references users(id),
  name text not null, total_kobo bigint not null check (total_kobo >= 10000), share_kobo bigint not null check (share_kobo > 0),
  created_at timestamptz not null default now());
create table if not exists bill_payments(
  bill_id uuid not null references bills(id) on delete cascade, user_id uuid not null references users(id),
  paid_at timestamptz not null default now(), primary key (bill_id, user_id));
create table if not exists help_requests(
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id), user_id uuid not null references users(id),
  amount_kobo bigint not null check (amount_kobo >= 50000), reason text not null,
  got_kobo bigint not null default 0, status text not null default 'open' check (status in ('open','closed')),
  created_at timestamptz not null default now());
create table if not exists help_gifts(
  help_id uuid not null references help_requests(id) on delete cascade, user_id uuid not null references users(id),
  amount_kobo bigint not null check (amount_kobo > 0), primary key (help_id, user_id));
