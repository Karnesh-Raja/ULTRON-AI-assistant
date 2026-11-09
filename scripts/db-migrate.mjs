import nextEnv from "@next/env";
import pg from "pg";
import { readdir, readFile } from "node:fs/promises";

nextEnv.loadEnvConfig(process.cwd());

const connectionString = process.env.DATABASE_MIGRATION_URL;
if (!connectionString) {
  console.error("DATABASE_MIGRATION_URL is missing. Add it to the ignored .env.local file.");
  process.exit(1);
}

const migrationDirectory = new URL("../db/migrations/", import.meta.url);
const migrationNames = (await readdir(migrationDirectory))
  .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
  .sort((a, b) => a.localeCompare(b));
const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000 });
let client;
let phase = "connecting to PostgreSQL";

try {
  client = await pool.connect();
  for (const name of migrationNames) {
    phase = `applying ${name}`;
    const migration = await readFile(new URL(name, migrationDirectory), "utf8");
    await client.query("BEGIN");
    await client.query(migration);
    await client.query("COMMIT");
  }
  console.log(`ULTRON local PostgreSQL schema is ready (${migrationNames.length} migrations checked).`);
} catch (error) {
  if (client) await client.query("ROLLBACK").catch(() => {});
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? `, PostgreSQL code ${error.code}`
    : "";
  console.error(`Could not finish the local PostgreSQL schema migration while ${phase}${code}. Check the local database settings and migration role. No connection details were printed.`);
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
