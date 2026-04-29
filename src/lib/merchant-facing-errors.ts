/**
 * Merchant / portal API responses must never expose upstream processor names, URLs, or raw payloads.
 * Full detail stays in logs and audit meta only.
 */

import type { FastifyReply } from "fastify";

import { ProviderCircuitOpenError } from "./provider-circuit-breaker.js";

const GENERIC_INTERNAL =
  "Something went wrong. Please try again or contact support if this persists.";
const PAYMENT_UNAVAILABLE =
  "Payment processing is temporarily unavailable. Please try again shortly.";
const PAYOUT_FAILED =
  "We could not complete this payout. Check your transaction list or try again.";
const OPERATION_FAILED = "Could not complete this request.";

/** Duck-type PayoutCreationError without importing services (avoids lib → service deps). */
function isPayoutCreationError(err: unknown): err is Error & {
  transactionId: string;
  platformOrderId: string | null;
} {
  return (
    err instanceof Error &&
    err.name === "PayoutCreationError" &&
    "transactionId" in err &&
    typeof (err as { transactionId?: unknown }).transactionId === "string"
  );
}

export type MerchantFacingBody = {
  error: string;
  message: string;
  code?: string;
  transactionId?: string;
  reference?: string;
  platformOrderId?: string | null;
};

export type MerchantFacingResult = {
  status: number;
  body: MerchantFacingBody;
  /** Safe for audit logs only — never send to clients. */
  logDetail?: string;
};

/**
 * Maps errors from pay-in / pay-out creation (merchant API + portal) to safe responses.
 */
export function merchantPaymentFlowErrorResponse(err: unknown): MerchantFacingResult {
  if (err instanceof ProviderCircuitOpenError) {
    return {
      status: 503,
      body: {
        error: "Service Unavailable",
        message: PAYMENT_UNAVAILABLE,
        code: "payment_unavailable",
      },
      logDetail: `circuit_open:${err.providerKey}`,
    };
  }

  if (isPayoutCreationError(err)) {
    return {
      status: 400,
      body: {
        error: "Bad Request",
        message: PAYOUT_FAILED,
        code: "payout_failed",
        transactionId: err.transactionId,
        reference: err.transactionId,
        platformOrderId: err.platformOrderId ?? null,
      },
      logDetail: err.message,
    };
  }

  const msg = err instanceof Error ? err.message : String(err);

  if (msg === "Insufficient balance") {
    return {
      status: 400,
      body: { error: "Bad Request", message: "Insufficient balance", code: "insufficient_balance" },
    };
  }

  if (msg === "Merchant wallet not found") {
    return {
      status: 400,
      body: { error: "Bad Request", message: "Wallet not available", code: "wallet_not_found" },
    };
  }

  if (msg === "Failed to create transaction") {
    return {
      status: 500,
      body: { error: "Internal", message: GENERIC_INTERNAL, code: "internal_error" },
      logDetail: msg,
    };
  }

  if (msg === "Tylt is not configured") {
    return {
      status: 503,
      body: {
        error: "Service Unavailable",
        message: PAYMENT_UNAVAILABLE,
        code: "payment_unavailable",
      },
      logDetail: msg,
    };
  }

  return {
    status: 500,
    body: { error: "Internal", message: GENERIC_INTERNAL, code: "internal_error" },
    logDetail: msg,
  };
}

const SAFE_PORTAL_OPERATION_MESSAGES = new Set([
  "Merchant wallet not found",
  "Failed to create customer wallet",
  "Invalid amount",
  "Wallet not found",
  "Customer wallet is blocked or pending",
  "Insufficient balance",
  "Failed to create transaction",
  "Failed to create refund transaction",
]);

/**
 * Portal transfer/refund and similar operations — only pass through known-safe internal messages.
 */
export function merchantPortalOperationErrorResponse(err: unknown): MerchantFacingResult {
  if (err instanceof ProviderCircuitOpenError) {
    return {
      status: 503,
      body: {
        error: "Service Unavailable",
        message: PAYMENT_UNAVAILABLE,
        code: "payment_unavailable",
      },
      logDetail: `circuit_open:${err.providerKey}`,
    };
  }

  const msg = err instanceof Error ? err.message : String(err);
  if (SAFE_PORTAL_OPERATION_MESSAGES.has(msg)) {
    return {
      status: 400,
      body: { error: "Bad Request", message: msg, code: "bad_request" },
    };
  }

  return {
    status: 400,
    body: { error: "Bad Request", message: OPERATION_FAILED, code: "operation_failed" },
    logDetail: msg,
  };
}

/** Satisfies Fastify + Zod literal status unions for payment-flow errors (400 / 500 / 503). */
export function sendMerchantFacingReply(reply: FastifyReply, mapped: MerchantFacingResult): void {
  switch (mapped.status) {
    case 400:
      void reply.status(400).send(mapped.body);
      return;
    case 503:
      void reply.status(503).send(mapped.body);
      return;
    case 500:
    default:
      void reply.status(500).send(mapped.body);
  }
}

/** Portal transfer/refund errors are only 400 (safe message) or 503 (circuit). */
export function sendPortalOperationReply(reply: FastifyReply, mapped: MerchantFacingResult): void {
  if (mapped.status === 503) {
    void reply.status(503).send(mapped.body);
    return;
  }
  void reply.status(400).send(mapped.body);
}
