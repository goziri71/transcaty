/**
 * Tekko-only static egress (QuotaGuard HTTP CONNECT).
 *
 * Do not set HTTP_PROXY / HTTPS_PROXY on the process. Only tekkoPlatformRequest
 * attaches this dispatcher so PayOK, Tylt, email, and merchant webhooks stay direct.
 */
import { ProxyAgent } from "undici";
import { getSecret } from "../../../src/lib/encryption.js";

export class TekkoStaticProxyNotConfiguredError extends Error {
  constructor() {
    super("Tekko static egress proxy is not configured");
    this.name = "TekkoStaticProxyNotConfiguredError";
  }
}

export class TekkoStaticProxyInvalidError extends Error {
  constructor(reason: string) {
    super(`Tekko static egress proxy URL is invalid (${reason})`);
    this.name = "TekkoStaticProxyInvalidError";
  }
}

let cachedAgent: { key: string; agent: ProxyAgent } | null = null;

function coalesce(...vals: (string | undefined | null)[]): string | undefined {
  for (const v of vals) {
    const t = v?.trim();
    if (t) return t;
  }
  return undefined;
}

function staticProxyRequired(): boolean {
  const raw = process.env.TEKKO_STATIC_PROXY_REQUIRED?.trim().toLowerCase();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return process.env.NODE_ENV === "production";
}

/** QuotaGuard / dedicated Tekko proxy URL. Never log the return value. */
export function readTekkoStaticProxyUrl(): string | undefined {
  return coalesce(
    getSecret("TEKKO_STATIC_PROXY_URL", "TEKKO_STATIC_PROXY_URL_ENC"),
    getSecret("QUOTAGUARDSTATIC_URL", "QUOTAGUARDSTATIC_URL_ENC")
  );
}

export type TekkoStaticProxySource =
  | "TEKKO_STATIC_PROXY_URL"
  | "TEKKO_STATIC_PROXY_URL_ENC"
  | "QUOTAGUARDSTATIC_URL"
  | "QUOTAGUARDSTATIC_URL_ENC";

/** Host/port only — never includes userinfo. For ops diagnostics. */
export function describeTekkoStaticProxy(): {
  required: boolean;
  configured: boolean;
  source: TekkoStaticProxySource | null;
  protocol: string | null;
  hostname: string | null;
  port: string | null;
  hasUser: boolean;
} {
  const required = staticProxyRequired();
  let source: TekkoStaticProxySource | null = null;
  if (process.env.TEKKO_STATIC_PROXY_URL?.trim()) source = "TEKKO_STATIC_PROXY_URL";
  else if (process.env.TEKKO_STATIC_PROXY_URL_ENC?.trim()) source = "TEKKO_STATIC_PROXY_URL_ENC";
  else if (process.env.QUOTAGUARDSTATIC_URL?.trim()) source = "QUOTAGUARDSTATIC_URL";
  else if (process.env.QUOTAGUARDSTATIC_URL_ENC?.trim()) source = "QUOTAGUARDSTATIC_URL_ENC";

  const raw = readTekkoStaticProxyUrl();
  if (!raw) {
    return {
      required,
      configured: false,
      source,
      protocol: null,
      hostname: null,
      port: null,
      hasUser: false,
    };
  }
  const parsed = validateTekkoStaticProxyUrl(raw);
  return {
    required,
    configured: true,
    source,
    protocol: parsed.protocol.replace(/:$/, ""),
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === "https:" ? "443" : "80"),
    hasUser: Boolean(parsed.username),
  };
}

export function validateTekkoStaticProxyUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TekkoStaticProxyInvalidError("unparseable");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TekkoStaticProxyInvalidError("must be http or https CONNECT proxy, not SOCKS");
  }
  if (!parsed.hostname) {
    throw new TekkoStaticProxyInvalidError("missing host");
  }
  return parsed;
}

/**
 * Undici ProxyAgent for Tekko Platform API calls, or undefined when optional and unset.
 * Throws in production (or when TEKKO_STATIC_PROXY_REQUIRED=true) if missing/invalid.
 */
export function getTekkoStaticProxyDispatcher(): ProxyAgent | undefined {
  const raw = readTekkoStaticProxyUrl();
  const required = staticProxyRequired();

  if (!raw) {
    if (required) throw new TekkoStaticProxyNotConfiguredError();
    return undefined;
  }

  validateTekkoStaticProxyUrl(raw);

  if (cachedAgent?.key === raw) return cachedAgent.agent;
  cachedAgent?.agent.close().catch(() => {
    /* ignore close races */
  });
  const agent = new ProxyAgent(raw);
  cachedAgent = { key: raw, agent };
  return agent;
}

/** Test helper — do not use in request paths. */
export function resetTekkoStaticProxyForTests(): void {
  cachedAgent?.agent.close().catch(() => {
    /* ignore */
  });
  cachedAgent = null;
}
