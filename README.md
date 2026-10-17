# Corredor API (`tic-api`)

Bun + Hono + PostgreSQL. Requires Bun and Docker. The payment rail defaults to a simulated adapter; no real money moves.

## Local setup

```sh
bun install
cp .env.example .env
bun run keys
```

Before starting the API, paste the generated `AUDIT_HMAC_KEY`, `AUDIT_SIGNING_KEY` and `AUDIT_PUBLIC_KEY` lines into `.env`, **replacing the empty entries**. Keep these values private and do not commit `.env`. Generate them once per environment and retain them between restarts: changing the keys prevents verification of existing audit events.

```sh
bun run db:up
bun run db:migrate
bun run dev
```

The API runs on http://localhost:3000. In another terminal, follow the [web setup](../tic-web/README.md). Create an account in the web app: sign-up creates a separate workspace and its fictional demo invoices. No shared seed or default account is needed. Do not seed or reset a remote database.

## Accounts, API access and MCP

- `/api/auth/signup`, `/api/auth/signin`, and `/api/auth/signout` provide database-backed accounts and HTTP-only cookie sessions. Passwords use Argon2id; only hashes of session and API tokens are stored.
- All application API routes require a valid session or workspace-bound bearer key, except `/api/health`. Browser mutations must send the configured `WEB_ORIGIN`.
- Account management in the web app supports invitations, workspace switching, and read-only API keys. A second payment approver must use a different real account. Client-supplied actor names do not choose the recorded identity.
- `/mcp` uses Streamable HTTP with bearer authentication. Tools can list payouts, read payout details, preview dated routes, list cited rules, read the Ledger, and verify audit evidence. They cannot approve, pay, change policy, or clear holds.
- Each workspace has separate payout, cache, settings, Ledger and audit tables. Resetting one sandbox does not reset another workspace or remove its authenticated members.
- Sign-up is not KYC. Business verification, beneficial-owner checks and supplier identity verification still need a dedicated workflow and verification provider before real-world use.

For deployment, set `WEB_ORIGIN` to the exact HTTPS web origin and keep audit keys stable in the platform’s secret store. HTTPS/production sessions use Secure, HTTP-only, SameSite=Lax cookies. Configure the web server’s `API_ORIGIN` to reach this API; its same-origin proxy forwards `/api/*` and `/mcp`.

Before presenting, check http://localhost:3000/api/health. Expect `"db": true`. If the first demo action reports `AUDIT_HMAC_KEY is not set`, complete the key-generation step above and restart the API.

## Optional: live agent and invoice extraction

Install Ollama on the demo machine, then:

```sh
ollama pull llama3.1:8b
ollama serve
```

If Ollama is already running as a service, do not start a second server. The default API settings use `http://localhost:11434` and `llama3.1:8b`; override `OLLAMA_URL` or `LLM_MODEL` in `.env` if needed, then restart the API.

Check http://localhost:3000/api/health again: `"llm": true` confirms the configured model is available. Without it, live chat and uncached PDF extraction are unavailable; seeded invoices and the deterministic payment workflow do not need a model.

See [docs/AGENT.md](./docs/AGENT.md) for model settings and extraction behavior, and [DATABASE.md](./DATABASE.md) for database setup and deployment.

## Docker

```sh
docker build -t tic-api .
docker run --env-file .env -p 3000:3000 tic-api
```

`DATABASE_URL` must reach Postgres from inside the container (a compose network or `host.docker.internal`, not localhost). The entrypoint applies migrations before starting, and the image bundles `data/` and `drizzle/`. From the hackathon root, `docker compose up -d --build` (see `../docker-compose.yml`) runs db + api + web at http://localhost:8080.

Migrations apply automatically at start, but the demo data needs a one-off seed: `docker compose exec api bun run src/db/seed.ts` from the hackathon root. It wipes and reseeds, which is also how you reset before the pitch.

## Checks

```sh
bun test test/rules.test.ts test/corredor.test.ts test/audit.test.ts test/rails.test.ts test/agent.test.ts test/presentation.test.ts
```

Run `bun run test` for unit, authenticated-workflow and auth/MCP suites. Integration tests require a migrated local `*_test` database in `TEST_DATABASE_URL`; `TEST_AUTH_DATABASE_URL` can optionally use another local test database. `bun run test:workflow` and `bun run test:auth` run them separately. The runner sets the database before modules load and never uses the application’s remote `DATABASE_URL`.

Workflow tests create a new isolated workspace rather than reseeding the shared database. The destructive sandbox-reset test is excluded by default; `bun run test:workflow --include-reset` deliberately opts into resetting only that run’s fixture workspace. Never point tests at a shared or production database.

## Fictional presentation screening

`GET /api/demo/screen?name=Demo%20Lumen%20Trading` runs the normal name-matching algorithm against invented organizations and aliases in `data/presentation/`. Every response includes `simulated: true` and a fictional list version. This read-only sandbox never participates in payout approval or replaces the real OFAC snapshot in `data/sdn.csv` and `data/alt.csv`.
