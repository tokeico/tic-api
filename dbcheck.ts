import { SQL } from "bun";

const sql = new SQL(process.env.DATABASE_URL!);
const v = await sql`select version() as version, current_database() as db, current_user as "user"`;
console.log(v[0]);
const schemas = await sql`select nspname from pg_namespace where nspname not like 'pg_%' and nspname <> 'information_schema' order by 1`;
console.log("schemas:", schemas.map((r: { nspname: string }) => r.nspname).join(", "));
const tables = await sql`select table_schema as s, table_name as t from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema') order by 1, 2`;
console.log("tables:");
for (const r of tables) console.log("  " + r.s + "." + r.t);
await sql.close();
