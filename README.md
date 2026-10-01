# empaz-api

The API behind Farverde Markets: accounts, sessions, and the four balances the
client dashboard is built around.

Standalone Express 5 on Node 22, Neon Postgres, no framework beyond that.
Deploys anywhere that runs a container or a Node process — Render, Railway,
Fly, Cloud Run, a VPS. It is **not** tied to the frontend's host.

---

## Running it

```bash
nvm use 22.22.1
npm install
cp .env.example .env     # then fill it in
npm run db:migrate       # once, against a fresh database
npm run dev              # http://localhost:8080
```

`npm run dev` uses `node --watch`, so edits restart the process.

## Environment

| Variable         | Required | What it does                                          |
| ---------------- | -------- | ----------------------------------------------------- |
| `DATABASE_URL`   | yes      | Neon pooled connection string                          |
| `AUTH_SECRET`    | yes      | Signs access tokens. `openssl rand -base64 32`         |
| `CORS_ORIGINS`   | yes      | Comma-separated frontend origins, no trailing slashes  |
| `PORT`           | no       | Defaults to 8080; most hosts inject their own          |
| `ADMIN_EMAIL`    | migrate  | First admin's email                                    |
| `ADMIN_PASSWORD` | migrate  | First admin's password, minimum 12 characters          |
| `ADMIN_NAME`     | no       | Display name, defaults to "Desk Administrator"         |

Rotating `AUTH_SECRET` invalidates every access token immediately; refresh
tokens keep working, so clients recover on their next refresh.

## Auth

The frontend is on a different host, so a session cookie would be a
third-party cookie and Safari and Firefox would drop it. Instead:

- **Access token** — HS256 JWT, 15 minutes, sent as `Authorization: Bearer …`.
  The browser keeps it in memory only.
- **Refresh token** — 32 opaque random bytes, 7 days. Only its SHA-256 is
  stored. It is **rotated on every use**: redeeming one revokes it and issues a
  fresh pair, so a stolen token stops working as soon as the real client
  refreshes.

Passwords are bcrypt at cost 10. Sign-in hashes a throwaway value when the
email is unknown, so response timing cannot be used to enumerate registered
addresses. Closing an account revokes all of its refresh tokens.

## Endpoints

| Method   | Path                                   | Who    |
| -------- | -------------------------------------- | ------ |
| `GET`    | `/health`                              | public |
| `POST`   | `/auth/signup`                         | public |
| `POST`   | `/auth/login`                          | public |
| `POST`   | `/auth/refresh`                        | public |
| `POST`   | `/auth/logout`                         | public |
| `GET`    | `/auth/me`                             | bearer |
| `GET`    | `/state`                               | bearer |
| `PATCH`  | `/accounts/:id`                        | admin  |
| `POST`   | `/accounts/:id/transactions`           | admin  |
| `DELETE` | `/accounts/:id/transactions/:txId`     | admin  |

`GET /state` returns every client plus the audit trail for an admin, and only
the caller's own account for a client. The frontend resyncs from it after any
mutation.

`PATCH /accounts/:id` takes one of three bodies:

```jsonc
{ "balances": { "credit": 148250, "withdraw": 42680.5 } }   // absolute
{ "adjust":   { "key": "credit", "delta": 5000 } }          // nudge one
{ "profile":  { "status": "Active", "tier": "Prime" } }      // terms + approval
```

Moving a pending account to `Active` is the approval step, and is logged as
`Account approved`.

## Signup flow

New accounts are created with status `Pending`, zero balances and an empty
ledger. The person can sign in immediately, but the frontend keeps their
dashboard locked until an admin approves them.

## Schema

`scripts/migrate.js` creates three tables and is safe to re-run:

- **accounts** — identity, status, terms, and `balances` / `history` /
  `holdings` / `transactions` as `jsonb`
- **refresh_tokens** — hashed token, expiry, revocation
- **audit_log** — every desk action, with actor and timestamp

## Deploying

Any container host, using the included `Dockerfile`:

```bash
docker build -t empaz-api .
docker run -p 8080:8080 --env-file .env empaz-api
```

Or as a plain Node service: build command `npm ci`, start command `npm start`,
health check `GET /health`.

Set the environment variables on the host, then run the migration once —
either locally against the production `DATABASE_URL`, or as a one-off job:

```bash
node --env-file=.env scripts/migrate.js
```

Remember to put the deployed frontend's origin in `CORS_ORIGINS`, or every
browser request will fail preflight.

## Layout

```
src/
  server.js          binds the port
  app.js             express app factory (CORS, JSON, routes, errors)
  db.js              Neon client, row mapper, audit helper
  tokens.js          access + refresh tokens, rotation
  middleware/auth.js readSession / requireSession / requireAdmin
  routes/            auth, state, accounts
scripts/migrate.js   schema + first admin
```
