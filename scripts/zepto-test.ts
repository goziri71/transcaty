#!/usr/bin/env npx tsx
/**
 * Test ZeptoMail token and email config.
 * Usage: tsx scripts/zepto-test.ts [recipient@email.com]
 *
 * Reads from .env: ZEPTOMAIL_TOKEN (_ENC), EMAIL_FROM (_ENC), ZEPTOMAIL_URL (optional)
 */
import "dotenv/config";
import { SendMailClient } from "zeptomail";
import { getSecret } from "../src/lib/encryption.js";

function parseFrom(from: string): { address: string; name: string } {
  const match = from.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) return { address: match[2].trim(), name: match[1].trim() };
  return { address: from.trim(), name: "Transacty" };
}

async function main() {
  const to = process.argv[2]?.trim() || process.env.ZEPTO_TEST_EMAIL?.trim();
  if (!to || !to.includes("@")) {
    console.error("Usage: tsx scripts/zepto-test.ts <recipient@email.com>");
    console.error("   Or: ZEPTO_TEST_EMAIL=you@example.com tsx scripts/zepto-test.ts");
    process.exit(1);
  }

  const token = getSecret("ZEPTOMAIL_TOKEN", "ZEPTOMAIL_TOKEN_ENC")?.trim();
  if (!token) {
    console.error("Error: ZEPTOMAIL_TOKEN or ZEPTOMAIL_TOKEN_ENC not set in .env");
    process.exit(1);
  }

  const from = getSecret("EMAIL_FROM", "EMAIL_FROM_ENC")?.trim();
  if (!from) {
    console.error("Error: EMAIL_FROM or EMAIL_FROM_ENC not set in .env");
    process.exit(1);
  }

  const baseUrl = process.env.ZEPTOMAIL_URL?.trim() || "https://api.zeptomail.com/";
  const parsed = parseFrom(from);

  console.log("\nZeptoMail test");
  console.log("  From:", parsed.address, `(${parsed.name})`);
  console.log("  To:", to);
  console.log("  API:", baseUrl);
  console.log("  Token:", token.startsWith("Zoho-enczapikey") ? "OK (Zoho-enczapikey...)" : "WARN (missing Zoho-enczapikey prefix?)");
  console.log("");

  try {
    const client = new SendMailClient({ url: baseUrl, token });
    await client.sendMail({
      from: { address: parsed.address, name: parsed.name },
      to: [{ email_address: { address: to, name: to.split("@")[0] } }],
      subject: "Transcaty ZeptoMail test",
      textbody: "If you receive this, ZeptoMail is working correctly.",
      htmlbody: "<p>If you receive this, ZeptoMail is working correctly.</p>",
    });
    console.log("SUCCESS: Email sent. Check inbox (and spam) at", to);
  } catch (e: unknown) {
    const resp = e && typeof e === "object" && "json" in e ? (e as { json: () => Promise<unknown> }) : null;
    let detail = e instanceof Error ? e.message : String(e);
    if (resp?.json) {
      try {
        const body = await resp.json();
        detail = JSON.stringify(body, null, 2);
      } catch {
        /* ignore */
      }
    }
    console.error("FAILED:", detail);
    process.exit(1);
  }
}

main();
