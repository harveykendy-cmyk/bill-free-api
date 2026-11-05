# Bill-Free API

Node 18+ / Express / Postgres / Paystack. Real accounts, real ledger, real deposits via Paystack dedicated virtual accounts.

## Run it
1. `npm install`
2. Create a Postgres DB (Neon, Supabase, Render all work), copy `.env.example` to `.env`, fill it in.
3. `npm run db:init`
4. `npm start`
5. In Paystack Dashboard > Settings > API Keys & Webhooks, set the webhook URL to `https://YOUR-DOMAIN/webhooks/paystack`.

Start with `sk_test_` keys and `PREFERRED_BANK=test-bank`. Test mode needs no real money.

## Frontend
`public/index.html` + `public/app.js` are served by the API at `/` (same origin, so no CORS setup). Sign up, dashboard, account number, balance, withdrawals, groups, chat and pooled loans all call the endpoints below. Bank codes in the withdraw form are in `BANKS` at the top of `app.js`; confirm them against Paystack's bank list.

Public pages (Home, About, Contact) show before sign up and lead to sign up and the dashboard. Contact form messages are stored in the `contact_messages` table (`select * from contact_messages order by id desc;`). Edit the copy in `public/app.js` (search for `landing()`, `about()`, `contact()`).

## How money flows
- Signup asks Paystack for a dedicated virtual account. The number arrives by webhook (`dedicatedaccount.assign.success`).
- A customer transfers into that number. Paystack sends `charge.success`. We re-verify with Paystack, then credit the ledger. `ledger.ref` is unique, so retries can never double-credit.
- Group saving and withdrawals are atomic debits. A failed payout is refunded automatically.
- Bill-Free earns `WITHDRAW_FEE_PCT` on each withdrawal. Paystack's own fees are separate; price accordingly.

## API (all routes except /auth/* and the webhook need `Authorization: Bearer <token>`)
| Area | Routes |
|---|---|
| Auth | `POST /auth/signup`, `POST /auth/login` |
| Account | `GET /me`, `GET /transactions`, `POST /withdraw`, `GET /banks/resolve` |
| Groups | `GET /groups`, `POST /groups`, `POST /groups/:id/members` (admin adds by phone), `POST /groups/:id/contribute` |
| Groups+ | `POST /groups/join` (invite code), `POST /groups/:id/draw` (admin, once, server-side shuffle then locked) |
| Bills | `GET /bills`, `POST /bills`, `POST /bills/:id/pay` |
| Help | `GET /help`, `POST /help`, `POST /help/:id/give`, `POST /help/:id/close` |
| Chat | `GET /chats` (rooms), `GET /chats/:conv/messages?after=<id>`, `POST /chats/:conv/messages` |
| Loans | `GET /loans`, `POST /loans`, `POST /loans/:id/lend`, `POST /loans/:id/cancel`, `POST /loans/:id/repay` |

Chat: group rooms for members, one-to-one only between people who share a group. Poll every 2 to 3 seconds with `after`. Upgrade to WebSockets or SSE when you scale.
Loans: 5/10/15% flat interest, 4/8/12 weeks, max 3 lenders, money held until fully funded, repayments split by share. All money moves use the same idempotent ledger as deposits.
Upgrading an existing database: re-run `npm run db:init` (it is safe to repeat).

## Nigeria-first features
- **Trust score** (`/me`, `/groups`, `/loans`, `/help`): computed from real data only: group savings in the ledger, weekly streaks, repaid loans, groups created, help given. Formula is in `trustFor()` in `server.js`.
- **Group types, deadlines, invite codes** (`#join-CODE` links work for new sign-ups), **fair payout draw**, **shared bills**, **urgent help** (a gift, not a loan).
- **Languages** (English, Pidgin, Yorùbá, Igbo, Hausa) for menus and greetings. Have native speakers review `I` in `public/app.js` before launch.
- **Installable and low-data**: `manifest.webmanifest` and `sw.js` cache the app shell so it opens fast and installs to the home screen. API data is never cached.
- **Security**: 10-minute inactivity logout in the browser, 12-hour login tokens, bcrypt passwords, lockout after 5 failed logins, rate limits, verified webhooks, idempotent ledger.
- **Not built yet**: airtime/data/electricity (needs a provider such as VTpass or Flutterwave Bills), USSD (Africa's Talking plus telco approval), automatic WhatsApp messages (WhatsApp Business API; today the app opens WhatsApp links), BVN/NIN checks, SMS OTP.

Re-run `npm run db:init` after updating (safe to repeat).

## Before real customers (do not skip)
- Paystack: dedicated accounts and transfers need an activated business account (CAC registration). Confirm DVA availability, the `assign` endpoint fields and webhook payloads against current Paystack docs. This code was not run against live Paystack.
- Lending: facilitating loans between users may fall under CBN digital-lending rules. Get legal advice before enabling loans for real money, and decide how defaults are handled (this code has no collections or default logic).
- Regulation: holding customers' savings is CBN-regulated. Get Nigerian fintech legal advice on your licensing or partner-bank structure.
- KYC: add BVN/NIN verification and transaction limits.
- Add OTP/2FA on login and withdrawals, an admin dashboard, backups, monitoring and tests.
- Paystack Transfers may require OTP approval; disable it in settings or add the finalize-transfer step.
