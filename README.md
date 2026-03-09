# Transcaty

B2B payment platform for domestic and cross-border pay-in and pay-out.

## Tech Stack

- **Runtime:** Node.js 20+
- **Language:** TypeScript
- **Framework:** Fastify
- **ORM:** Drizzle
- **Validation:** Zod
- **Database:** PostgreSQL
- **Job Queue:** pg-boss

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

   If you hit an `esbuild` install error, try a clean install:

   ```bash
   rm -rf node_modules package-lock.json
   npm cache clean --force
   npm install
   ```

2. **Configure environment**

   ```bash
   cp .env.example .env
   # Edit .env with your PostgreSQL connection string
   ```

3. **Create database**

   ```bash
   createdb transcaty
   ```

4. **Run migrations**

   ```bash
   npm run db:push
   ```

5. **Start development server**

   ```bash
   npm run dev
   ```

## Scripts

| Command        | Description                    |
|----------------|--------------------------------|
| `npm run dev`  | Start dev server with hot reload |
| `npm run build`| Build for production           |
| `npm run start`| Run production build           |
| `npm run db:generate` | Generate Drizzle migrations |
| `npm run db:migrate`   | Run migrations         |
| `npm run db:push`     | Push schema to DB      |
| `npm run db:studio`   | Open Drizzle Studio   |

## Endpoints

- `GET /` - API info
- `GET /health` - Health check (DB + pg-boss)
