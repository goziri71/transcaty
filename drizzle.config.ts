import "dotenv/config";
import { defineConfig } from "drizzle-kit";

function withSsl(url: string): string {
  if (url.includes("sslmode=")) return url;
  if (url.includes("localhost") || url.includes("127.0.0.1")) return url;
  const ssl = "uselibpqcompat=true&sslmode=require";
  return url.includes("?") ? `${url}&${ssl}` : `${url}?${ssl}`;
}

const dbUrl = process.env.DATABASE_URL ?? "postgresql://localhost:5432/transcaty";

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: withSsl(dbUrl),
  },
});
