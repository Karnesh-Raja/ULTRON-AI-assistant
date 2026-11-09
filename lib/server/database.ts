import { Pool } from "pg";
import { getConnectionString } from "@netlify/database";

type DatabaseGlobal = typeof globalThis & { ultronPgPool?: Pool };

/** Reuse one small PostgreSQL pool across Next.js requests and dev hot reloads. */
export function getDatabasePool(): Pool {
  const globalWithPool = globalThis as DatabaseGlobal;
  if (globalWithPool.ultronPgPool) return globalWithPool.ultronPgPool;

  const connectionString = process.env.DATABASE_URL || getConnectionString();

  const pool = new Pool({
    connectionString,
    max: process.env.NETLIFY ? 1 : 4,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  pool.on("error", () => {
    // Do not log connection details; they can contain host or credential information.
    console.error("[database] idle PostgreSQL connection error.");
  });
  globalWithPool.ultronPgPool = pool;
  return pool;
}
