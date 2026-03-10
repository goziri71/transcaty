import PgBoss from "pg-boss";
import { ensureDbSsl, getSecret } from "./encryption.js";

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

export const queue = new PgBoss({
  connectionString,
  max: 5,
});
