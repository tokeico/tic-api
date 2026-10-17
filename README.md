To install dependencies:
```sh
bun install
```

To run:
```sh
bun run dev
```

open http://localhost:3000

## Database

```sh
cp .env.example .env
bun run db:up && bun run db:migrate
```

See [DATABASE.md](./DATABASE.md) for the full workflow and deployment guide.
