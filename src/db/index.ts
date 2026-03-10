import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";
import { ensureDbSsl, getSecret } from "../lib/encryption.js";

const raw = getSecret("DATABASE_URL", "DATABASE_URL_ENC");
const connectionString = ensureDbSsl(
  raw ?? (process.env.RENDER ? "" : "postgresql://localhost:5432/transcaty")
);

if (!connectionString) {
  throw new Error(
    "DATABASE_URL or DATABASE_URL_ENC must be set. " +
      "On Render: add env vars in Dashboard → Environment, or link a PostgreSQL service."
  );
}

const pool = new pg.Pool({ connectionString });

export const db = drizzle(pool, { schema });
