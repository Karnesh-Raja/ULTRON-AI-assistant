import { Pool } from "pg";

type DatabaseGlobal = typeof globalThis & { ultronPgPool?: Pool };

/** Reuse one small PostgreSQL pool across Next.js requests and dev hot reloads. */
export function getDatabasePool(): Pool {
  const globalWithPool = globalThis as DatabaseGlobal;
  if (globalWithPool.ultronPgPool) return globalWithPool.ultronPgPool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not configured.");

  const pool = new Pool({
    connectionString,
    max: 4,
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
