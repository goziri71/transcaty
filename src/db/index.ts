import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";

const connectionString = process.env.DATABASE_URL ?? "postgresql://localhost:5432/transcaty";

const pool = new pg.Pool({ connectionString });

export const db = drizzle(pool, { schema });
