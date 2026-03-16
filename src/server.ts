import "dotenv/config"; // Must be first - loads .env before other imports

import { buildApp } from "../app.js";
import { queue } from "./lib/queue.js";
import { getMerchantWebhookJobName, sendMerchantWebhook, type WebhookEvent } from "./lib/merchant-webhook.js";

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

async function main() {
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
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
