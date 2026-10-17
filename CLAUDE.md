
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun check` instead of `tsc --noEmit`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Type checking

Use `bun check` to type check the project. It reads `tsconfig.json` and reports the same errors as `tsc`.

- `bun check src/index.ts` checks one file and what it imports
- `bun --check src/index.ts`, `bun test --check` and `bun build --check` type check first, and do nothing else if there is an error

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## Database

PostgreSQL + Drizzle ORM (`drizzle-orm/bun-sql`, which uses `Bun.SQL`), run with Docker Compose.
**Read `DATABASE.md` before touching the schema, migrations or deployment.**
Short version: edit `src/db/schema.ts`, run `bun run db:generate`, run `bun run db:migrate`, then commit `drizzle/`.
Import `db` from `src/db`. Never use `db:push` against shared or production databases.
JSON columns: use `jsonb` from `src/db/jsonb.ts`, never drizzle's built-in one (it double-encodes under Bun.SQL).
Reset demo data with `bun run db:seed`.

## Agent (local LLM)

The Agent tab uses a local model in Ollama with read-only tools. **Read `docs/AGENT.md` before touching `src/llm/`.** Never add a tool that acts; actions go through `propose_action` for a person to confirm.

## Authenticated database context and verification

- Application services use the request-scoped `db`; direct service callers must enter `withWorkspace` with a verified principal. `adminDb` is reserved for identity administration and migration/maintenance scripts, never a fallback for unauthenticated application requests.
- Use `bun run test`, `bun run test:workflow`, or `bun run test:auth`. The runner initializes separate processes with local `*_test` database URLs before modules load, so the remote application database cannot be selected accidentally. The workspace-reset test requires explicit `--include-reset`.
- Workspace provisioning clones the listed application tables and reinstalls foreign keys and append-only audit triggers. Schema changes must account for existing workspace schemas as well as `public`; root migrations alone do not upgrade tenant tables.
- Authenticated accounts and name screening are not KYC/KYB completion. Do not claim provider-verified identities or collect real identity documents without a verification provider and secure storage.
