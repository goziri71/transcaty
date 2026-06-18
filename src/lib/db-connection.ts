import { ensureDbSsl, getSecret } from "./encryption.js";

const LOCAL_DEFAULT = "postgresql://localhost:5432/transacty";

/** Same connection string as the API runtime (plain or decrypted DATABASE_URL_ENC). */
export function resolveDatabaseUrl(): string {
  const raw = getSecret("DATABASE_URL", "DATABASE_URL_ENC");
  const base = raw ?? (process.env.RENDER ? "" : LOCAL_DEFAULT);
  if (!base) {
    throw new Error(
      "DATABASE_URL or DATABASE_URL_ENC must be set (e.g. in .env or Render environment)."
    );
  }
  return ensureDbSsl(base);
}

export function describeDatabaseTarget(url: string): {
  host: string;
  port: string;
  database: string;
  user: string;
} {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port || "5432",
    database: u.pathname.replace(/^\//, "").split("?")[0],
    user: u.username || "(default)",
  };
}

export function isLocalDefaultUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      (u.hostname === "localhost" || u.hostname === "127.0.0.1") &&
      (u.pathname.replace(/^\//, "").split("?")[0] === "transacty" ||
        u.pathname === "/transacty")
    );
  } catch {
    return false;
  }
}
