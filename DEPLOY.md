# Put Bill-Free online (Render, about 10 minutes)

1. **GitHub:** create a new repository and upload everything in this folder (not `node_modules`, not `.env`).
2. **Render:** sign in at render.com > New > **Blueprint** > choose your repository > Apply.
   It reads `render.yaml` and creates the web service and a Postgres database for you.
3. When asked for `PAYSTACK_SECRET`, paste your **test** secret key (starts with `sk_test_`) from Paystack > Settings > API Keys.
4. Wait for the deploy to finish. Render shows your public address, like `https://bill-free.onrender.com`. Open it on any device and send it to your friend.
5. In Paystack > Settings > API Keys & Webhooks, set the webhook URL to `https://YOUR-ADDRESS/webhooks/paystack`.

Notes
- The free web service sleeps when nobody uses it, so the first visit after a break can take about a minute.
- Free databases may have time limits. Check Render's current free-tier terms and use a paid plan for real customers.
- Use test keys until you have finished the checks in README.md ("Before real customers").
- Running locally instead: copy `.env.example` to `.env`, fill it in, then `npm install`, `npm run db:init`, `npm start`.
