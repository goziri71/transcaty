import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";
import { resolveDatabaseUrl } from "../lib/db-connection.js";

const connectionString = resolveDatabaseUrl();

function envInt(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.floor(n);
}

const POOL_MAX = envInt("DB_POOL_MAX", 20, 1);
const IDLE_TIMEOUT_MS = envInt("DB_POOL_IDLE_TIMEOUT_MS", 30_000, 0);
const CONNECTION_TIMEOUT_MS = envInt("DB_POOL_CONNECTION_TIMEOUT_MS", 5_000, 0);
const STATEMENT_TIMEOUT_MS = envInt("DB_STATEMENT_TIMEOUT_MS", 15_000, 0);
const QUERY_TIMEOUT_MS = envInt("DB_QUERY_TIMEOUT_MS", 15_000, 0);
const APPLICATION_NAME =
  process.env.DB_APPLICATION_NAME?.trim() || "transacty";

const pool = new pg.Pool({
  connectionString,
  max: POOL_MAX,
  idleTimeoutMillis: IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  // Postgres-side timeouts. Set on every fresh connection so a runaway
  // statement cannot pin a pool slot indefinitely.
  statement_timeout: STATEMENT_TIMEOUT_MS,
  query_timeout: QUERY_TIMEOUT_MS,
  application_name: APPLICATION_NAME,
  // Force keep-alive on the underlying socket so idle pool entries stay
  // warm behind cloud TCP timeouts (Render, Neon, RDS proxies).
  keepAlive: true,
});

// Surface pool-level errors via stderr so the process supervisor can react.
// pg will already log per-client errors when they happen on a checked-out
// client, but errors emitted on idle clients otherwise crash the process.
pool.on("error", (err) => {
  // eslint-disable-next-line no-console
  console.error("[db] idle client error:", err.message);
});

export const db = drizzle(pool, { schema });

/** Best-effort pool teardown. Safe to call multiple times. */
export async function closeDb(): Promise<void> {
  try {
    await pool.end();
  } catch {
    /* already closed */
  }
}
