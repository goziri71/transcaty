import "dotenv/config";
import { defineConfig } from "drizzle-kit";
import { resolveDatabaseUrl } from "./src/lib/db-connection.js";

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: resolveDatabaseUrl(),
  },
});
