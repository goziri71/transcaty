import "dotenv/config"; // Must be first - loads .env before other imports

import { buildApp } from "../app.js";
import { queue } from "./lib/queue.js";
import { getMerchantWebhookJobName, sendMerchantWebhook, type WebhookEvent } from "./lib/merchant-webhook.js";
import {
  TRANSACTIONAL_EMAIL_JOB,
  deliverTransactionalEmail,
  type TransactionalEmailPayload,
} from "./lib/transactional-email-queue.js";
import { disconnectRedis } from "./lib/redis.js";
import { runMonthlyBilling } from "./lib/billing/monthly-billing.js";

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

function validateEnv() {
  const portalSecret = process.env.PORTAL_JWT_SECRET ?? process.env.JWT_SECRET;
  if (!portalSecret?.trim()) {
    throw new Error(
      "PORTAL_JWT_SECRET or JWT_SECRET is required for portal auth (signup/login). " +
        "Add it to Render Environment. Generate: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
}

async function main() {
  validateEnv();
  await queue.start();

  await queue.work(
    getMerchantWebhookJobName(),
    { batchSize: 5 },
    async (jobs) => {
      for (const job of jobs) {
        const { merchantId, event } = job.data as { merchantId: string; event: WebhookEvent };
        try {
          await sendMerchantWebhook(merchantId, event);
        } catch (err) {
          throw err;
        }
      }
    }
  );

  await queue.work(
    TRANSACTIONAL_EMAIL_JOB,
    { batchSize: 3 },
    async (jobs) => {
      for (const job of jobs) {
        await deliverTransactionalEmail(job.data as TransactionalEmailPayload);
      }
    }
  );

  const MONTHLY_BILLING_JOB = "monthly-billing";
  await queue.createQueue(MONTHLY_BILLING_JOB);
  await queue.work(MONTHLY_BILLING_JOB, async () => {
    const result = await runMonthlyBilling();
    console.log(JSON.stringify({ monthlyBilling: result }));
  });
  await queue.schedule(MONTHLY_BILLING_JOB, "0 0 1 * *", {});

  const app = await buildApp();

  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`Server running at http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async () => {
    app.log.info("Shutting down...");
    await app.close();
    await queue.stop();
    await disconnectRedis();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
