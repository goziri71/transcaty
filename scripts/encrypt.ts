#!/usr/bin/env npx tsx
/**
 * Encrypt a secret for *_ENC env vars (same AES-256-GCM as getSecret()).
 *
 * Usage:
 *   npm run encrypt -- "plaintext-secret"
 *   npm run encrypt -- --file .secrets/tekko/private.pem
 *   npm run encrypt -- --file .secrets/tekko/private.pem --name TEKKO_LIVE_PRIVATE_KEY_ENC
 *
 * ENCRYPTION_MASTER_KEY must be set (env or .env) — same key used at runtime.
 */
import { readFileSync } from "node:fs";
import { config } from "dotenv";
config();

import { encrypt } from "../src/lib/encryption.js";

function parseArgs(argv: string[]): { plaintext: string | null; envName: string | null } {
  let file: string | null = null;
  let envName: string | null = null;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file" || a === "-f") {
      file = argv[++i] ?? null;
      continue;
    }
    if (a === "--name" || a === "-n") {
      envName = argv[++i] ?? null;
      continue;
    }
    if (a === "--help" || a === "-h") {
      console.log(`Usage:
  npm run encrypt -- "secret"
  npm run encrypt -- --file path/to/private.pem
  npm run encrypt -- --file path/to/private.pem --name TEKKO_LIVE_PRIVATE_KEY_ENC
`);
      process.exit(0);
    }
    rest.push(a);
  }
  if (file) {
    return { plaintext: readFileSync(file, "utf8"), envName };
  }
  return { plaintext: rest[0] ?? null, envName };
}

const { plaintext, envName } = parseArgs(process.argv.slice(2));
const masterKey = process.env.ENCRYPTION_MASTER_KEY;

if (!plaintext) {
  console.error('Usage: npm run encrypt -- "secret"   OR   npm run encrypt -- --file path');
  process.exit(1);
}

if (!masterKey) {
  console.error("Error: ENCRYPTION_MASTER_KEY must be set in env or .env");
  process.exit(1);
}

try {
  const encrypted = encrypt(plaintext, masterKey);
  const label = envName ?? "*_ENC";
  console.log(`\nEncrypted (paste into .env as ${label}=...):\n`);
  console.log(encrypted);
  console.log("");
} catch (err) {
  console.error("Encryption failed:", err);
  process.exit(1);
}
