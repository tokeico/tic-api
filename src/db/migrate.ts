// Applies pending SQL migrations from ./drizzle to DATABASE_URL.
// Usage: bun run db:migrate
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { client, db } from "./index";

await migrate(db, { migrationsFolder: "./drizzle" });
console.log("Migrations applied");
await client.close();
