import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

// Example table: replace or extend with the real domain tables.
// After editing this file run `bun run db:generate` then `bun run db:migrate`.
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
