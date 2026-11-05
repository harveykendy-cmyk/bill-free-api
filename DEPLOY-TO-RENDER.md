# Deploy Bill-Free (test/demo only)

This project can be deployed as a Node/Express web service with PostgreSQL on Render. The included render.yaml defines a demo service and database. Free databases may have storage and expiry limits and are not suitable for production financial records.

## Deploy
1. Connect this GitHub repository to Render.
2. In Render choose **New + → Blueprint**, select this repository, and apply render.yaml.
3. Add PAYSTACK_SECRET in the Render service environment using a Paystack **test** key (sk_test_...). Never put secrets in GitHub or frontend files.
4. Wait for the service and database to provision. Render will show the service URL.
5. Check https://YOUR-RENDER-URL/health; expected response: {"ok":true}.

## Database
After provisioning, run npm run db:init once from the Render Shell.

## Paystack webhook
For test mode, configure https://YOUR-RENDER-URL/webhooks/paystack.

## Important
This is a demo deployment recipe, not approval to operate a financial service. Do not use live keys or real customer funds until qualified Nigerian fintech counsel and a regulated financial partner have reviewed the product, funds flow, security and licensing. Use a production-grade database and backups before any approved launch.