/**
 * Tekko end-customers: one Platform customer per Transacty merchant (phase 1).
 */
import { eq } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { merchants } from "../../../src/db/schema/index.js";
import { UpstreamProviderClientError } from "../../../src/lib/merchant-facing-errors.js";
import { tekkoGet, tekkoPost } from "./client.js";

export function tekkoExternalIdForMerchant(merchantId: string): string {
  return `transacty-merchant-${merchantId}`;
}

function extractCustomerId(json: unknown): number | null {
  if (!json || typeof json !== "object") return null;
  const root = json as Record<string, unknown>;
  const data = root.data;
  const candidates: unknown[] = [
    root.id,
    root.endUserId,
    data && typeof data === "object" ? (data as Record<string, unknown>).id : null,
    data && typeof data === "object" ? (data as Record<string, unknown>).endUserId : null,
  ];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
    if (typeof c === "string" && /^\d+$/.test(c)) return Number(c);
  }
  return null;
}

/**
 * Ensure a Tekko customer exists for this merchant; persist `tekkoCustomerId` on merchants.
 */
export async function ensureTekkoCustomerForMerchant(params: {
  merchantId: string;
  displayName?: string;
}): Promise<number> {
  const [row] = await db
    .select({
      id: merchants.id,
      name: merchants.name,
      tekkoCustomerId: merchants.tekkoCustomerId,
    })
    .from(merchants)
    .where(eq(merchants.id, params.merchantId))
    .limit(1);

  if (!row) throw new Error("Merchant not found");

  if (row.tekkoCustomerId?.trim()) {
    const n = Number(row.tekkoCustomerId.trim());
    if (Number.isFinite(n)) return n;
  }

  const externalId = tekkoExternalIdForMerchant(params.merchantId);
  const idempotencyKey = `tekko-customer-${params.merchantId}`.slice(0, 255);
  const res = await tekkoPost(
    "/customers",
    {
      externalId,
      displayName: params.displayName?.trim() || row.name,
      metadata: { transactyMerchantId: params.merchantId },
    },
    idempotencyKey,
    { label: "tekko create customer" }
  );

  let customerId = extractCustomerId(res.json);

  // Idempotent replay / already exists — try list lookup by externalId if create didn't return id.
  if (customerId == null && (res.status === 200 || res.status === 201 || res.status === 409)) {
    const listed = await tekkoGet(`/customers?take=100`, { label: "tekko list customers" });
    customerId = findCustomerIdByExternalId(listed.json, externalId);
  }

  if (customerId == null) {
    const msg =
      res.json && typeof res.json === "object" && typeof (res.json as { message?: unknown }).message === "string"
        ? (res.json as { message: string }).message
        : `Tekko create customer failed (${res.status})`;
    if (res.status >= 400 && res.status < 500) {
      throw new UpstreamProviderClientError(msg, msg, res.status);
    }
    throw new Error(msg);
  }

  await db
    .update(merchants)
    .set({ tekkoCustomerId: String(customerId), updatedAt: new Date() })
    .where(eq(merchants.id, params.merchantId));

  return customerId;
}

function findCustomerIdByExternalId(json: unknown, externalId: string): number | null {
  if (!json || typeof json !== "object") return null;
  const root = json as Record<string, unknown>;
  const data = root.data ?? root.items ?? root.customers ?? root;
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { items?: unknown }).items)
      ? ((data as { items: unknown[] }).items)
      : null;
  if (!list) return null;
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (row.externalId === externalId) {
      if (typeof row.id === "number") return row.id;
      if (typeof row.id === "string" && /^\d+$/.test(row.id)) return Number(row.id);
    }
  }
  return null;
}
