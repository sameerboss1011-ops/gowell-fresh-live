GOWELL — FRESH RAZORPAY PAYMENT STARTER (VERSION 2)
==================================================

WHAT THIS PACKAGE INCLUDES
- index.html: GoWell UI with Supabase settings placeholders and a Razorpay checkout button.
- server.js: new backend with Supabase token validation, server-created Razorpay orders,
  server-side payment signature verification, Razorpay API captured-status confirmation,
  a signed webhook handler, and wallet-credit RPC call.
- supabase-schema.sql: wallet, ledger, payment order tables, signup trigger, and an atomic,
  idempotent wallet-credit function.
- .env.example: backend environment variable names only; contains no real secrets.

IMPORTANT LIMITS
This is an integration starter, not a live deployed service. It cannot accept real payments until
all environment variables are configured, the SQL is run in the intended Supabase project,
the backend is deployed, Razorpay test mode passes, and Razorpay has approved the actual business
model and use case. Razorpay may restrict wallet loads, investment/earning plans, money-transfer
or similar use cases; get written approval before accepting live funds. Do not advertise guaranteed
returns or income. The UI's plan/reward screens are not proof of a compliant financial product.
Withdrawals/admin payout features are not implemented in this package.

SETUP — FOLLOW IN ORDER
1. Create/choose a Supabase project that you are allowed to use. Back up existing data first.
2. In Supabase SQL Editor, run supabase-schema.sql. Review it before running if the project has
   existing tables/triggers. Do not run against a production project without a backup.
3. Deploy this folder as a new Node.js backend (Node 18+). Set the environment variables from
   .env.example in the backend host's Environment/Secrets settings. Never place the service-role
   key or Razorpay key secret in HTML, GitHub, screenshots, or chat.
4. Start with Razorpay TEST keys (rzp_test_...). Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to
   backend environment variables only.
5. In Razorpay Dashboard, configure a webhook URL: https://YOUR-BACKEND-DOMAIN/api/razorpay/webhook
   Subscribe to payment.captured. Set a long random webhook secret and put the exact same value in
   RAZORPAY_WEBHOOK_SECRET on the backend.
6. In index.html, replace YOUR-NEW-PROJECT.supabase.co with the Supabase project URL,
   YOUR_SUPABASE_PUBLISHABLE_KEY with that project's publishable/anon key, and
   YOUR-NEW-BACKEND.onrender.com with the deployed backend URL. These are public/browser settings;
   never put service role or Razorpay secret here.
7. Set ALLOWED_ORIGIN to the exact website origin (for GitHub Pages, e.g. https://username.github.io).
8. Open https://YOUR-BACKEND-DOMAIN/health. Confirm databaseConfigured and paymentsEnabled are true.
9. Sign up a test user, sign in, and use Razorpay TEST mode. Test success, failure, cancel, duplicate
   callback/webhook, wrong amount and expired login. Confirm one wallet_ledger row and one wallet
   credit only for a captured successful payment. Check Razorpay Dashboard and Supabase records.
10. Only after tests and Razorpay's written business-model approval should you consider live keys.
    Never test with real money before the wallet/ledger result is confirmed.

SECURITY NOTES
- Browser cannot set the amount outside the server-side allowlist.
- Order creation requires a valid Supabase user token.
- Signature and Razorpay captured status are verified server-side before credit.
- Wallet credit and ledger insert are atomic and idempotent per payment ID.
- User-facing wallet/ledger reads are protected by row-level security.
- A real production launch still needs security review, rate limiting, monitoring, refund/reversal
  handling, webhook event persistence/retries, support/refund flows, privacy terms, and compliance.
