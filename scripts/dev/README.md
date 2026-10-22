# Developer scripts

One-off maintenance and debugging scripts. They are not part of the app and are never bundled into it.

Each script reads `EXPO_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from a local `.env`. The service-role key bypasses Row-Level Security, so these scripts are for a developer's machine against a project you own. Run them from the repo root, for example `node scripts/dev/check-schema.mjs`.

| Script | Purpose |
| :--- | :--- |
| `check-schema.mjs` | Print table columns |
| `check-balances.mjs` | Print computed balances |
| `check-settlements.mjs` | Print simplified settlements |
| `check_query.mjs <user-id>` | Run the transaction query for one user |
| `check-user.mjs <email>` | Look up an auth user and confirm their email |
| `check-category.mjs`, `check-negative.mjs`, `check-split-type.mjs` | Write and then delete test rows to check constraints |
| `check-insert.mjs` | Insert a test expense (no cleanup; use a dev project) |
| `auto-verify.mjs` | Mark every unconfirmed user as email-confirmed (dev projects only) |
| `reset-pass.mjs <email> <new-password>` | Set a user's password |
