/**
 * Payok signature: SHA256WithRSA, Base64.
 * Plaintext = {json_body}&{endpoint_path}
 */
import { createSign, createVerify } from "node:crypto";

/** Normalize PEM: ensure Unix line endings, trim. */
function normalizePem(pem: string): string {
  return pem.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

/** Convert raw base64 (no PEM headers) to PEM format. */
function base64ToPem(base64: string, type: "private" | "public" = "private"): string {
  const cleaned = base64.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(cleaned)) {
    throw new Error(`Invalid base64 for ${type} key.`);
  }
  const lines = cleaned.match(/.{1,64}/g) ?? [];
  const header = type === "public" ? "-----BEGIN PUBLIC KEY-----" : "-----BEGIN PRIVATE KEY-----";
  const footer = type === "public" ? "-----END PUBLIC KEY-----" : "-----END PRIVATE KEY-----";
  return `${header}\n${lines.join("\n")}\n${footer}`;
}

function toPublicPem(value: string): string {
  const normalized = normalizePem(value);
  if (normalized.includes("-----BEGIN PUBLIC KEY-----")) return normalized;
  if (/^[A-Za-z0-9+/=\s]+$/.test(normalized)) return base64ToPem(normalized, "public");
  throw new Error("Public key must be PEM or base64.");
}

/** Get PEM from value: already PEM, or raw base64 to convert. */
function toPem(value: string): string {
  const normalized = normalizePem(value);
  if (normalized.includes("-----BEGIN")) {
    return normalized;
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(normalized)) {
    return base64ToPem(normalized, "private");
  }
  throw new Error("Private key must be PEM or base64. Got neither.");
}

/**
 * Sign a request body for Payok.
 */
export function signPayokRequest(
  jsonBody: string,
  endpointPath: string,
  privateKeyInput: string
): string {
  const pem = toPem(privateKeyInput);
  const plaintext = `${jsonBody}&${endpointPath}`;
  const sign = createSign("RSA-SHA256");
  sign.update(plaintext, "utf8");
  try {
    return sign.sign(pem, "base64");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("DECODER") || msg.includes("unsupported")) {
      throw new Error(
        "Private key format not supported. Ensure the key is PEM (-----BEGIN PRIVATE KEY----- or -----BEGIN RSA PRIVATE KEY-----). " +
          "If Payok gave a .p12/.pfx file, extract the PEM first. " +
          "Original: " + msg
      );
    }
    throw err;
  }
}

/** Normalize base64 signature from headers/proxies to standard base64 bytes. */
function normalizeBase64Signature(sig: string): string {
  let normalized = sig.trim();
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep original when value is not URL-encoded.
  }
  // Some proxies/frameworks can turn "+" into space in headers.
  normalized = normalized.replace(/ /g, "+");
  normalized = normalized.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const mod = normalized.length % 4;
  if (mod !== 0) normalized += "=".repeat(4 - mod);
  return normalized;
}

/**
 * Verify a callback signature from Payok.
 * Doc: Plaintext = {json_body}&{endpoint_path}
 */
function verifyWithPlaintext(
  plaintext: string,
  signatureBase64: string,
  publicKeyInput: string
): boolean {
  const pem = toPublicPem(publicKeyInput);
  const sig = normalizeBase64Signature(signatureBase64);
  const algorithms = ["RSA-SHA256", "sha256"] as const;
  for (const algorithm of algorithms) {
    const verify = createVerify(algorithm);
    verify.update(plaintext, "utf8");
    try {
      if (verify.verify(pem, sig, "base64")) return true;
    } catch {
      // Try next algorithm.
    }
  }
  return false;
}

export function verifyPayokCallback(
  jsonBody: string,
  endpointPath: string,
  signatureBase64: string,
  publicKeyInput: string
): boolean {
  return verifyWithPlaintext(`${jsonBody}&${endpointPath}`, signatureBase64, publicKeyInput);
}

type BodyVariant = "raw" | "trimmed" | "minified" | "canonical";
type PlaintextMode = "body" | "body&path" | "path&body" | "body+path" | "path+body";

export type PayokSignatureVerificationDebug = {
  verified: boolean;
  match?: {
    bodyVariant: BodyVariant;
    mode: PlaintextMode;
    path: string | null;
  };
  diagnostics: {
    bodyVariantCount: number;
    pathVariantCount: number;
    attempts: number;
  };
};

/** Minify JSON: parse and stringify to remove spaces (per Payok: remove spaces before signing). */
function minifyJsonBody(jsonStr: string): string | null {
  try {
    return JSON.stringify(JSON.parse(jsonStr));
  } catch {
    return null;
  }
}

/** Canonicalize JSON: parse and stringify with sorted keys (no extra whitespace). */
function canonicalizeJson(jsonStr: string): string | null {
  try {
    const obj = JSON.parse(jsonStr) as object;
    return JSON.stringify(sortKeys(obj));
  } catch {
    return null;
  }
}

function sortKeys(obj: object): object {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);
  return Object.keys(obj)
    .sort()
    .reduce((acc, k) => {
      acc[k] = sortKeys((obj as Record<string, unknown>)[k] as object);
      return acc;
    }, {} as Record<string, unknown>);
}

/**
 * Verify callback signature. Tries multiple path formats, plaintext orders, and body variants.
 * Per Payok: stringify and remove spaces before signing. We try raw, minified, and canonical.
 */
export function verifyPayokCallbackWithFallbacks(
  jsonBody: string,
  pathCandidates: string[],
  signatureBase64: string,
  publicKeyInput: string
): boolean {
  return verifyPayokCallbackWithFallbacksDebug(jsonBody, pathCandidates, signatureBase64, publicKeyInput).verified;
}

export function verifyPayokCallbackWithFallbacksDebug(
  jsonBody: string,
  pathCandidates: string[],
  signatureBase64: string,
  publicKeyInput: string
): PayokSignatureVerificationDebug {
  const bodyVariants: Array<{ name: BodyVariant; value: string }> = [];
  const pushBody = (name: BodyVariant, value: string | null | undefined) => {
    if (!value) return;
    if (!bodyVariants.some((v) => v.value === value)) bodyVariants.push({ name, value });
  };
  pushBody("raw", jsonBody);
  pushBody("trimmed", jsonBody.trim());
  pushBody("minified", minifyJsonBody(jsonBody));
  pushBody("canonical", canonicalizeJson(jsonBody));

  const normalizedPaths: string[] = [];
  const pushPath = (value: string | null | undefined) => {
    if (!value) return;
    const v = value.trim();
    if (!v) return;
    if (!normalizedPaths.includes(v)) normalizedPaths.push(v);
  };
  for (const candidate of pathCandidates) {
    pushPath(candidate);
    pushPath(candidate.replace(/\/$/, ""));
    pushPath(candidate.startsWith("/") ? candidate.slice(1) : `/${candidate}`);
    pushPath(candidate.startsWith("/") ? candidate : candidate.slice(1));
    try {
      const asUrl = new URL(candidate);
      pushPath(asUrl.pathname);
      pushPath(asUrl.pathname.replace(/\/$/, ""));
      pushPath(asUrl.pathname.startsWith("/") ? asUrl.pathname.slice(1) : asUrl.pathname);
    } catch {
      // Candidate is a path, not an absolute URL.
    }
  }

  let attempts = 0;
  for (const body of bodyVariants) {
    attempts += 1;
    if (verifyWithPlaintext(body.value, signatureBase64, publicKeyInput)) {
      return {
        verified: true,
        match: { bodyVariant: body.name, mode: "body", path: null },
        diagnostics: {
          bodyVariantCount: bodyVariants.length,
          pathVariantCount: normalizedPaths.length,
          attempts,
        },
      };
    }
    for (const path of normalizedPaths) {
      const candidates: Array<{ mode: PlaintextMode; plaintext: string }> = [
        { mode: "body&path", plaintext: `${body.value}&${path}` },
        { mode: "path&body", plaintext: `${path}&${body.value}` },
        { mode: "body+path", plaintext: `${body.value}${path}` },
        { mode: "path+body", plaintext: `${path}${body.value}` },
      ];
      for (const candidate of candidates) {
        attempts += 1;
        if (verifyWithPlaintext(candidate.plaintext, signatureBase64, publicKeyInput)) {
          return {
            verified: true,
            match: { bodyVariant: body.name, mode: candidate.mode, path },
            diagnostics: {
              bodyVariantCount: bodyVariants.length,
              pathVariantCount: normalizedPaths.length,
              attempts,
            },
          };
        }
      }
    }
  }

  return {
    verified: false,
    diagnostics: {
      bodyVariantCount: bodyVariants.length,
      pathVariantCount: normalizedPaths.length,
      attempts,
    },
  };
}
