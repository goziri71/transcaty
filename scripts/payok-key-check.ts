#!/usr/bin/env npx tsx
/**
 * Check decrypted Payok private key format (diagnostic only).
 * Does NOT log the key content.
 */
import "dotenv/config";
import { getSecret } from "../src/lib/encryption.js";

function main() {
  const raw = getSecret("PAYOK_MERCHANT_PRI_KEY", "PAYOK_MERCHANT_PRI_KEY_ENC");
  if (!raw) {
    console.log("PAYOK_MERCHANT_PRI_KEY_ENC not set or decrypt failed.");
    process.exit(1);
  }

  const trimmed = raw.trim().replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const firstLine = trimmed.split("\n")[0];
  const hasBegin = trimmed.includes("-----BEGIN");
  const hasEnd = trimmed.includes("-----END");
  const lineCount = trimmed.split("\n").length;

  console.log("Decrypted key check:\n");
  console.log("  First line:", firstLine?.slice(0, 50) + (firstLine && firstLine.length > 50 ? "..." : ""));
  console.log("  Has -----BEGIN:", hasBegin);
  console.log("  Has -----END:", hasEnd);
  console.log("  Line count:", lineCount);
  console.log("  Total length:", trimmed.length);

  if (!hasBegin || !hasEnd) {
    console.log("\n  ✗ Not a valid PEM. Expected format:");
    console.log("    merchantId (optional first line)");
    console.log("    -----BEGIN PRIVATE KEY-----");
    console.log("    ...base64...");
    console.log("    -----END PRIVATE KEY-----");
    console.log("\n  If Payok gave .p12/.pfx: openssl pkcs12 -in file.p12 -nocerts -nodes -out key.pem");
    console.log("  Then encrypt: npm run encrypt -- \"$(cat key.pem)\"");
  } else {
    console.log("\n  ✓ PEM format detected.");
  }
}

main();
