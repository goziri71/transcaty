import PgBoss from "pg-boss";

const connectionString = process.env.DATABASE_URL ?? "postgresql://localhost:5432/transcaty";

export const queue = new PgBoss({
  connectionString,
  max: 5,
});
