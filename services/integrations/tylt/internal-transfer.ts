/**
 * Tylt internal wallet transfer (§7): GET getMerchantDetails + POST transferMerchantBalance.
 */
import { eq } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { transactions } from "../../../src/db/schema/index.js";
import { audit } from "../../../src/lib/audit.js";
import { getSecret } from "../../../src/lib/encryption.js";
import { tyltSignedGetJson, tyltSignedPostJson } from "./client.js";
import type { TyltMerchantEnvironment } from "./config.js";

const RAIL = "tylt";
export const TYLT_PRODUCT_INTERNAL_TRANSFER = "internal_transfer";

export function parseInternalTransferPairAllowlistJson(raw: string | undefined): Set<string> {
  const set = new Set<string>();
  if (!raw?.trim()) return set;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return set;
    for (const pair of parsed) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const a = String(pair[0]).trim().toLowerCase();
      const b = String(pair[1]).trim().toLowerCase();
      if (a && b) set.add(`${a}|${b}`);
    }
  } catch {
    return set;
  }
  return set;
}

/** Directed pairs only: `[[fromUuid, toUuid], ...]` — JSON in env (see integration spec). */
export function getInternalTransferPairAllowlist(environment: TyltMerchantEnvironment): Set<string> {
  const testSpecific = getSecret(
    "TYLT_TEST_INTERNAL_TRANSFER_PAIR_ALLOWLIST",
    "TYLT_TEST_INTERNAL_TRANSFER_PAIR_ALLOWLIST_ENC"
  );
  const liveSpecific = getSecret(
    "TYLT_LIVE_INTERNAL_TRANSFER_PAIR_ALLOWLIST",
    "TYLT_LIVE_INTERNAL_TRANSFER_PAIR_ALLOWLIST_ENC"
  );
  const shared = getSecret("TYLT_INTERNAL_TRANSFER_PAIR_ALLOWLIST", "TYLT_INTERNAL_TRANSFER_PAIR_ALLOWLIST_ENC");
  const raw = environment === "live" ? liveSpecific ?? shared : testSpecific ?? shared;
  return parseInternalTransferPairAllowlistJson(raw ?? undefined);
}

export function assertInternalTransferPairAllowed(
  environment: TyltMerchantEnvironment,
  fromUUID: string,
  toUUID: string
): void {
  const allowlist = getInternalTransferPairAllowlist(environment);
  if (allowlist.size === 0) {
    throw new Error("Internal transfer not configured");
  }
  const key = `${fromUUID.trim().toLowerCase()}|${toUUID.trim().toLowerCase()}`;
  if (!allowlist.has(key)) {
    throw new Error("Transfer pair not allowed");
  }
}

export async function tyltGetMerchantDetails(environment: TyltMerchantEnvironment) {
  return tyltSignedGetJson({
    environment,
    path: "/transactions/merchant/getMerchantDetails",
    queryParams: {},
  });
}

export async function tyltTransferMerchantBalance(params: {
  environment: TyltMerchantEnvironment;
  fromUUID: string;
  toUUID: string;
  settledAmount: string;
  settledCurrency: string;
  comments?: string;
}) {
  const body: Record<string, unknown> = {
    fromUUID: params.fromUUID.trim(),
    toUUID: params.toUUID.trim(),
    settledAmount: params.settledAmount,
    settledCurrency: params.settledCurrency.trim(),
  };
  if (params.comments?.trim()) body.comments = params.comments.trim();
  return tyltSignedPostJson<Record<string, unknown>>({
    environment: params.environment,
    path: "/transactions/merchant/transferMerchantBalance",
    body,
  });
}

function extractTransferPlatformOrderId(json: unknown): string | null {
  const root = json as Record<string, unknown>;
  const data = (root.data ?? root.result ?? root) as Record<string, unknown>;
  const candidates = [
    data.platformOrderId,
    data.orderId,
    data.transactionId,
    data.id,
    root.platformOrderId,
    root.orderId,
    root.transactionId,
  ];
  for (const c of candidates) {
    const s = typeof c === "string" ? c.trim() : "";
    if (s) return s;
  }
  return null;
}

export async function executeTyltInternalTransfer(params: {
  merchantId: string;
  environment: TyltMerchantEnvironment;
  fromUUID: string;
  toUUID: string;
  settledAmount: string;
  settledCurrency: string;
  comments?: string;
}): Promise<{ transactionId: string; platformOrderId: string | null }> {
  assertInternalTransferPairAllowed(params.environment, params.fromUUID, params.toUUID);

  const metadata = {
    rail: RAIL,
    tyltProduct: TYLT_PRODUCT_INTERNAL_TRANSFER,
    fromUUID: params.fromUUID.trim(),
    toUUID: params.toUUID.trim(),
    ...(params.comments?.trim() ? { comments: params.comments.trim() } : {}),
  };

  const [tx] = await db
    .insert(transactions)
    .values({
      merchantId: params.merchantId,
      environment: params.environment,
      type: "transfer",
      status: "pending",
      amount: params.settledAmount,
      currency: params.settledCurrency.trim(),
      metadata: JSON.stringify(metadata),
    })
    .returning();

  if (!tx) throw new Error("Failed to create transaction");

  let status: number;
  let json: Record<string, unknown>;
  try {
    const res = await tyltTransferMerchantBalance({
      environment: params.environment,
      fromUUID: params.fromUUID,
      toUUID: params.toUUID,
      settledAmount: params.settledAmount,
      settledCurrency: params.settledCurrency,
      comments: params.comments,
    });
    status = res.status;
    json = res.json;
  } catch (err) {
    const prev = tx.metadata ? (JSON.parse(tx.metadata) as Record<string, unknown>) : {};
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(transactions)
      .set({
        status: "failed",
        metadata: JSON.stringify({
          ...prev,
          failedStage: "transferMerchantBalance",
          failureReason: msg,
        }),
        updatedAt: new Date(),
      })
      .where(eq(transactions.id, tx.id));
    audit({
      action: "provider.tylt.internal_transfer.failed",
      resource: tx.id,
      merchantId: params.merchantId,
      meta: { fromUUID: params.fromUUID, toUUID: params.toUUID, error: msg },
    });
    throw err;
  }

  const platformOrderId = extractTransferPlatformOrderId(json);

  if (status >= 400 || !platformOrderId) {
    const prev = tx.metadata ? (JSON.parse(tx.metadata) as Record<string, unknown>) : {};
    await db
      .update(transactions)
      .set({
        status: "failed",
        metadata: JSON.stringify({
          ...prev,
          failedStage: "transferMerchantBalance",
          failureReason: typeof json === "object" ? JSON.stringify(json) : String(json),
        }),
        updatedAt: new Date(),
      })
      .where(eq(transactions.id, tx.id));

    audit({
      action: "provider.tylt.internal_transfer.failed",
      resource: tx.id,
      merchantId: params.merchantId,
      meta: {
        platformOrderId: platformOrderId ?? null,
        httpStatus: status,
        fromUUID: params.fromUUID,
        toUUID: params.toUUID,
      },
    });

    throw new Error("Tylt internal transfer failed");
  }

  await db
    .update(transactions)
    .set({ status: "success", externalId: platformOrderId, updatedAt: new Date() })
    .where(eq(transactions.id, tx.id));

  audit({
    action: "provider.tylt.internal_transfer.completed",
    resource: tx.id,
    merchantId: params.merchantId,
    meta: {
      platformOrderId,
      fromUUID: params.fromUUID,
      toUUID: params.toUUID,
      settledCurrency: params.settledCurrency,
    },
  });

  return { transactionId: tx.id, platformOrderId };
}
