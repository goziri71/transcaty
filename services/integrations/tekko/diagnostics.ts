/**
 * Ops-facing PYUSD / Tekko failure diagnostics for server logs.
 * Never includes secrets, PEMs, webhook secrets, deposit addresses, or raw proxy userinfo.
 */
import { getTekkoLiveConfig } from "./config.js";
import { describeTekkoStaticProxy } from "./static-proxy.js";

export type TekkoPyusdFailSurface =
  | "v1.create"
  | "v1.get"
  | "portal.create"
  | "portal.get"
  | "portal.gate"
  | "tekko.create_upstream";

export type TekkoOpsSnapshot = {
  nodeEnv: string;
  tekkoCredentialsLoaded: boolean;
  tekkoWebhookSecretConfigured: boolean;
  tekkoBaseUrlHost: string | null;
  proxyConfigured: boolean;
  proxyRequired: boolean;
  proxySource: string | null;
  proxyHost: string | null;
};

/** Safe env / rail snapshot (booleans + hosts only). */
export function tekkoOpsSnapshot(): TekkoOpsSnapshot {
  const cfg = getTekkoLiveConfig();
  const proxy = describeTekkoStaticProxy();
  let tekkoBaseUrlHost: string | null = null;
  if (cfg?.baseUrl) {
    try {
      tekkoBaseUrlHost = new URL(cfg.baseUrl).host;
    } catch {
      tekkoBaseUrlHost = "(unparseable)";
    }
  }
  const proxyHost =
    proxy.hostname != null ? `${proxy.hostname}${proxy.port ? `:${proxy.port}` : ""}` : null;
  return {
    nodeEnv: process.env.NODE_ENV ?? "(unset)",
    tekkoCredentialsLoaded: cfg != null,
    tekkoWebhookSecretConfigured: Boolean(cfg?.webhookSecret),
    tekkoBaseUrlHost,
    proxyConfigured: proxy.configured,
    proxyRequired: proxy.required,
    proxySource: proxy.source,
    proxyHost,
  };
}

/** Stable cause tag for grepping logs when merchants only see payment_unavailable. */
export function classifyTekkoPyusdError(err: unknown): string {
  if (err && typeof err === "object" && "name" in err) {
    const name = String((err as { name: unknown }).name);
    if (name === "ProviderCircuitOpenError") return "circuit_open";
    if (name === "TekkoStaticProxyNotConfiguredError") return "static_proxy_not_configured";
    if (name === "TekkoStaticProxyInvalidError") return "static_proxy_invalid";
    if (name === "UpstreamProviderClientError") {
      const msg = err instanceof Error ? err.message : "";
      if (/live-only|no sandbox/i.test(msg)) return "test_environment_rejected";
      if (/credentials not configured/i.test(msg)) return "tekko_credentials_missing";
      return "upstream_client_rejected";
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/live-only|only available in the live/i.test(msg)) return "test_environment_rejected";
  if (/Tekko credentials not configured/i.test(msg)) return "tekko_credentials_missing";
  if (/static egress proxy/i.test(msg)) return "static_proxy_error";
  if (/\btekko\b/i.test(msg) && /request failed after/i.test(msg)) return "tekko_upstream_retries_exhausted";
  if (/create payment intent failed/i.test(msg)) return "tekko_create_intent_failed";
  if (/Failed to create transaction/i.test(msg)) return "db_insert_failed";
  return "unknown";
}

function errFields(err: unknown): {
  errName: string;
  errMessage: string;
  errStack?: string;
} {
  if (err instanceof Error) {
    return {
      errName: err.name,
      errMessage: err.message.slice(0, 500),
      errStack: err.stack?.split("\n").slice(0, 6).join("\n"),
    };
  }
  return { errName: typeof err, errMessage: String(err).slice(0, 500) };
}

export type LogTekkoPyusdFailureParams = {
  surface: TekkoPyusdFailSurface;
  err: unknown;
  merchantId?: string;
  environment?: string;
  merchantReference?: string;
  amount?: string;
  transactionId?: string;
  /** Merchant-facing mapped status/code (optional). */
  httpStatus?: number;
  merchantCode?: string;
  logDetail?: string;
  /** Extra safe fields (no secrets). */
  extra?: Record<string, string | number | boolean | null | undefined>;
};

/**
 * Structured Fastify log + one console line so Render / local terminals show the root cause.
 */
export function logTekkoPyusdFailure(
  log: { error: (obj: object, msg?: string) => void; warn?: (obj: object, msg?: string) => void },
  params: LogTekkoPyusdFailureParams
): void {
  const cause = classifyTekkoPyusdError(params.err);
  const ops = tekkoOpsSnapshot();
  const fields = errFields(params.err);
  const payload = {
    rail: "pyusd" as const,
    surface: params.surface,
    cause,
    merchantId: params.merchantId,
    environment: params.environment,
    merchantReference: params.merchantReference,
    amount: params.amount,
    transactionId: params.transactionId,
    httpStatus: params.httpStatus,
    merchantCode: params.merchantCode,
    logDetail: params.logDetail ?? fields.errMessage,
    ...fields,
    ops,
    ...(params.extra ?? {}),
  };

  log.error(payload, "pyusd.tekko.failure");

  const line = [
    "[PYUSD]",
    `surface=${params.surface}`,
    `cause=${cause}`,
    params.environment ? `env=${params.environment}` : null,
    params.merchantId ? `merchant=${params.merchantId}` : null,
    params.httpStatus != null ? `http=${params.httpStatus}` : null,
    params.merchantCode ? `code=${params.merchantCode}` : null,
    `creds=${ops.tekkoCredentialsLoaded}`,
    `proxy=${ops.proxyConfigured}/${ops.proxyRequired ? "required" : "optional"}`,
    `detail=${(params.logDetail ?? fields.errMessage).slice(0, 200)}`,
  ]
    .filter(Boolean)
    .join(" ");
  console.error(line);
}
