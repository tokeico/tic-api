// Applies pending SQL migrations from ./drizzle to DATABASE_URL.
// Usage: bun run db:migrate
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { client, adminDb } from "./index";

await migrate(adminDb, { migrationsFolder: "./drizzle" });
console.log("Migrations applied");
await client.close();
