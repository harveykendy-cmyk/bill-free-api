# Bill-Free API

Node 18+ / Express / PostgreSQL / Paystack application.

## Run locally
1. npm install
2. Create a PostgreSQL database and copy .env.example to .env.
3. Set DATABASE_URL, JWT_SECRET and a Paystack test key.
4. npm run db:init
5. npm start

The web app is served from public/index.html and public/app.js.

## Important safety and deployment note
Use test credentials and dummy data only. This code has not been independently audited or verified against live Paystack. Before any real-money use, obtain qualified Nigerian fintech legal/compliance review and a regulated financial partner; implement KYC, OTP/2FA, transaction limits, monitoring, backups and operational controls. Holding savings and facilitating lending can trigger regulatory requirements. Never commit secrets to GitHub.