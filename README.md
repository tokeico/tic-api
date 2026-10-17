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
bun run db:seed
bun run dev
```

The API runs on http://localhost:3000. In another terminal, follow the [web setup](../tic-web/README.md).

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

## Checks

```sh
bun test test/rules.test.ts test/corredor.test.ts test/audit.test.ts test/rails.test.ts test/agent.test.ts test/presentation.test.ts
```

The PostgreSQL integration suite in `test/payouts.test.ts` additionally needs a dedicated `*_test` database. It wipes and reseeds that database; see `.env.example` for setup.

## Fictional presentation screening

`GET /api/demo/screen?name=Demo%20Lumen%20Trading` runs the normal name-matching algorithm against invented organizations and aliases in `data/presentation/`. Every response includes `simulated: true` and a fictional list version. This read-only sandbox never participates in payout approval or replaces the real OFAC snapshot in `data/sdn.csv` and `data/alt.csv`.
