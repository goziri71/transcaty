#!/usr/bin/env npx tsx
/**
 * Decrypt *_ENC env values (same AES-256-GCM as getSecret() at runtime).
 *
 * Usage:
 *   npm run decrypt -- PAYOK_LIVE_BASE_URL_ENC
 *   npm run decrypt -- PAYOK_LIVE_BASE_URL          # getSecret(plain, plain_ENC)
 *   npm run decrypt -- --ciphertext "iv:tag:cipher"
 *   npm run decrypt -- PAYOK_LIVE_MERCHANT_PRI_KEY_ENC --preview
 *   npm run decrypt -- PAYOK_LIVE_BASE_URL_ENC --length-only
 *
 * ENCRYPTION_MASTER_KEY must be set (env or .env) — same key used when encrypting.
 * Dev/ops only: do not log decrypted output in shared channels.
 */
import { config } from "dotenv";
config();

import { decrypt, getSecret } from "../src/lib/encryption.js";

function looksLikeEncrypted(value: string): boolean {
  const parts = value.trim().split(":");
  return parts.length === 3 && parts.every((p) => /^[0-9a-fA-F]+$/.test(p));
}

function parseArgs(argv: string[]): {
  envName: string | null;
  ciphertext: string | null;
  preview: boolean;
  lengthOnly: boolean;
} {
  let envName: string | null = null;
  let ciphertext: string | null = null;
  let preview = false;
  let lengthOnly = false;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ciphertext" || a === "-c") {
      ciphertext = argv[++i] ?? null;
      continue;
    }
    if (a === "--preview" || a === "-p") {
      preview = true;
      continue;
    }
    if (a === "--length-only" || a === "-l") {
      lengthOnly = true;
      continue;
    }
    if (a === "--help" || a === "-h") {
      console.log(`Usage:
  npm run decrypt -- PAYOK_LIVE_BASE_URL_ENC
  npm run decrypt -- PAYOK_LIVE_BASE_URL
  npm run decrypt -- --ciphertext "iv:authTag:ciphertext"
  npm run decrypt -- PAYOK_LIVE_MERCHANT_PRI_KEY_ENC --preview
  npm run decrypt -- DATABASE_URL_ENC --length-only
`);
      process.exit(0);
    }
    rest.push(a);
  }

  if (!ciphertext && rest[0]) {
    envName = rest[0];
  }
  return { envName, ciphertext, preview, lengthOnly };
}

function encryptedKeyForPlain(name: string): string {
  return name.endsWith("_ENC") ? name : `${name}_ENC`;
}

function resolvePlaintext(params: {
  envName: string | null;
  ciphertext: string | null;
}): { label: string; plaintext: string } {
  const masterKey = process.env.ENCRYPTION_MASTER_KEY;
  if (!masterKey?.trim()) {
    throw new Error("ENCRYPTION_MASTER_KEY must be set in env or .env");
  }

  if (params.ciphertext) {
    return {
      label: "ciphertext",
      plaintext: decrypt(params.ciphertext.trim(), masterKey.trim()),
    };
  }

  if (!params.envName) {
    throw new Error("Provide an env var name or --ciphertext");
  }

  const name = params.envName.trim();
  const raw = process.env[name];
  if (!raw?.trim()) {
    throw new Error(`Env var ${name} is not set or empty`);
  }

  if (name.endsWith("_ENC") || looksLikeEncrypted(raw)) {
    return {
      label: name,
      plaintext: decrypt(raw.trim(), masterKey.trim()),
    };
  }

  const encKey = encryptedKeyForPlain(name);
  const resolved = getSecret(name, encKey);
  if (resolved === undefined) {
    throw new Error(
      `Could not resolve ${name}. Set plain value, encrypted-looking plain, or ${encKey}.`
    );
  }
  return { label: `${name} (via getSecret)`, plaintext: resolved };
}

function previewValue(value: string): string {
  if (value.length <= 12) return "***";
  if (value.startsWith("-----BEGIN")) {
    const lines = value.split("\n");
    return `${lines[0]}\n…${value.length} chars…\n${lines[lines.length - 1] ?? ""}`;
  }
  try {
    const u = new URL(value);
    const user = u.username ? `${u.username.slice(0, 2)}***@` : "";
    return `${u.protocol}//${user}${u.hostname}${u.pathname !== "/" ? u.pathname : ""}`;
  } catch {
    /* not a URL */
  }
  return `${value.slice(0, 6)}…${value.slice(-4)} (${value.length} chars)`;
}

const { envName, ciphertext, preview, lengthOnly } = parseArgs(process.argv.slice(2));

try {
  const { label, plaintext } = resolvePlaintext({ envName, ciphertext });

  if (lengthOnly) {
    console.log(`OK  ${label}  length=${plaintext.length}`);
    process.exit(0);
  }

  console.log(`\nDecrypted ${label}:\n`);
  console.log(preview ? previewValue(plaintext) : plaintext);
  console.log("");
} catch (err) {
  console.error("Decryption failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
