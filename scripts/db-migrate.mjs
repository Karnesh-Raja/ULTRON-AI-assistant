import { loadEnvConfig } from "@next/env";
import pg from "pg";
import { readFile } from "node:fs/promises";

loadEnvConfig(process.cwd());

const connectionString = process.env.DATABASE_MIGRATION_URL;
if (!connectionString) {
  console.error("DATABASE_MIGRATION_URL is missing. Add it to the ignored .env.local file.");
  process.exit(1);
}

const migration = await readFile(new URL("../db/migrations/0001_create_memories.sql", import.meta.url), "utf8");
const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000 });
let client;

try {
  client = await pool.connect();
  await client.query("BEGIN");
  await client.query(migration);
  await client.query("COMMIT");
  console.log("ULTRON memory schema is ready.");
} catch {
  if (client) await client.query("ROLLBACK").catch(() => {});
  console.error("Could not apply the ULTRON memory schema. Check the local database settings and migration role.");
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
