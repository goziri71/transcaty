/**
 * Per-market merchant compliance records (encrypted BVN, VA details).
 * Provider-neutral — suitable for regulatory retention/export.
 */
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { merchantMarketCompliance, merchants } from "../db/schema/index.js";
import { decrypt, encrypt } from "./encryption.js";

export const NIGERIA_MARKET = "nigeria" as const;

export const BVN_STATUSES = ["not_submitted", "pending", "verified", "failed"] as const;
export type BvnVerificationStatus = (typeof BVN_STATUSES)[number];

export type NigeriaBvnSubmission = {
  bvn: string;
  firstName: string;
  lastName: string;
  phoneNumber?: string;
  dateOfBirth?: string;
  customerEmail?: string;
};

export type NigeriaComplianceRow = {
  merchantId: string;
  market: typeof NIGERIA_MARKET;
  bvnVerificationStatus: BvnVerificationStatus;
  bvnFirstName: string | null;
  bvnLastName: string | null;
  bvnPhoneNumber: string | null;
  bvnDateOfBirth: string | null;
  bvnEmail: string | null;
  bvnVerifiedAt: Date | null;
  vaStatus: string | null;
  vaAccountNumber: string | null;
  vaBankName: string | null;
  vaAccountName: string | null;
};

function getMasterKeyForPii(): string {
  const k = process.env.ENCRYPTION_MASTER_KEY?.trim();
  if (!k) {
    throw new Error(
      "ENCRYPTION_MASTER_KEY is required to store market compliance data (encrypted BVN)"
    );
  }
  return k;
}

export function encryptBvn(bvn: string): string {
  return encrypt(bvn.replace(/\s/g, ""), getMasterKeyForPii());
}

export function decryptBvn(bvnEnc: string): string {
  return decrypt(bvnEnc, getMasterKeyForPii());
}

export function normalizeBvnVerificationStatus(
  raw: string | null | undefined
): BvnVerificationStatus {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "verified" || s === "pending" || s === "failed" || s === "not_submitted") {
    return s;
  }
  return "not_submitted";
}

function mapComplianceRow(row: typeof merchantMarketCompliance.$inferSelect): NigeriaComplianceRow {
  return {
    merchantId: row.merchantId,
    market: NIGERIA_MARKET,
    bvnVerificationStatus: normalizeBvnVerificationStatus(row.bvnVerificationStatus),
    bvnFirstName: row.bvnFirstName?.trim() || null,
    bvnLastName: row.bvnLastName?.trim() || null,
    bvnPhoneNumber: row.bvnPhoneNumber?.trim() || null,
    bvnDateOfBirth: row.bvnDateOfBirth?.trim() || null,
    bvnEmail: row.bvnEmail?.trim() || null,
    bvnVerifiedAt: row.bvnVerifiedAt,
    vaStatus: row.vaStatus?.trim() || null,
    vaAccountNumber: row.vaAccountNumber?.trim() || null,
    vaBankName: row.vaBankName?.trim() || null,
    vaAccountName: row.vaAccountName?.trim() || null,
  };
}

async function loadLegacyNigeriaRow(merchantId: string): Promise<NigeriaComplianceRow | null> {
  const [m] = await db
    .select({
      tekkoBvnStatus: merchants.tekkoBvnStatus,
      tekkoNgnVaStatus: merchants.tekkoNgnVaStatus,
      tekkoNgnVaAccountNumber: merchants.tekkoNgnVaAccountNumber,
      tekkoNgnVaBankName: merchants.tekkoNgnVaBankName,
      tekkoNgnVaAccountName: merchants.tekkoNgnVaAccountName,
    })
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .limit(1);

  if (!m) return null;
  const hasLegacy =
    m.tekkoBvnStatus?.trim() ||
    m.tekkoNgnVaAccountNumber?.trim() ||
    m.tekkoNgnVaStatus?.trim();
  if (!hasLegacy) return null;

  return {
    merchantId,
    market: NIGERIA_MARKET,
    bvnVerificationStatus: normalizeBvnVerificationStatus(m.tekkoBvnStatus),
    bvnFirstName: null,
    bvnLastName: null,
    bvnPhoneNumber: null,
    bvnDateOfBirth: null,
    bvnEmail: null,
    bvnVerifiedAt: null,
    vaStatus: m.tekkoNgnVaStatus?.trim() || null,
    vaAccountNumber: m.tekkoNgnVaAccountNumber?.trim() || null,
    vaBankName: m.tekkoNgnVaBankName?.trim() || null,
    vaAccountName: m.tekkoNgnVaAccountName?.trim() || null,
  };
}

export async function getNigeriaMarketCompliance(
  merchantId: string
): Promise<NigeriaComplianceRow | null> {
  const [row] = await db
    .select()
    .from(merchantMarketCompliance)
    .where(
      and(
        eq(merchantMarketCompliance.merchantId, merchantId),
        eq(merchantMarketCompliance.market, NIGERIA_MARKET)
      )
    )
    .limit(1);

  if (row) return mapComplianceRow(row);
  return loadLegacyNigeriaRow(merchantId);
}

/** Persist encrypted BVN + identity fields before forwarding to a payment rail. */
export async function saveNigeriaBvnSubmission(
  merchantId: string,
  submission: NigeriaBvnSubmission
): Promise<void> {
  const bvn = submission.bvn.replace(/\s/g, "");
  const now = new Date();
  const values = {
    merchantId,
    market: NIGERIA_MARKET,
    bvnEnc: encryptBvn(bvn),
    bvnFirstName: submission.firstName.trim(),
    bvnLastName: submission.lastName.trim(),
    bvnPhoneNumber: submission.phoneNumber?.trim() || null,
    bvnDateOfBirth: submission.dateOfBirth?.trim() || null,
    bvnEmail: submission.customerEmail?.trim() || null,
    bvnVerificationStatus: "pending" as const,
    updatedAt: now,
  };

  await db
    .insert(merchantMarketCompliance)
    .values(values)
    .onConflictDoUpdate({
      target: [merchantMarketCompliance.merchantId, merchantMarketCompliance.market],
      set: {
        bvnEnc: values.bvnEnc,
        bvnFirstName: values.bvnFirstName,
        bvnLastName: values.bvnLastName,
        bvnPhoneNumber: values.bvnPhoneNumber,
        bvnDateOfBirth: values.bvnDateOfBirth,
        bvnEmail: values.bvnEmail,
        bvnVerificationStatus: values.bvnVerificationStatus,
        updatedAt: now,
      },
    });
}

export async function updateNigeriaBvnVerificationStatus(
  merchantId: string,
  status: BvnVerificationStatus
): Promise<void> {
  const now = new Date();
  const verifiedAt = status === "verified" ? now : null;

  await db
    .insert(merchantMarketCompliance)
    .values({
      merchantId,
      market: NIGERIA_MARKET,
      bvnVerificationStatus: status,
      bvnVerifiedAt: verifiedAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [merchantMarketCompliance.merchantId, merchantMarketCompliance.market],
      set: {
        bvnVerificationStatus: status,
        bvnVerifiedAt: verifiedAt,
        updatedAt: now,
      },
    });
}

export async function updateNigeriaVaDetails(
  merchantId: string,
  patch: {
    vaStatus?: string | null;
    vaAccountNumber?: string | null;
    vaBankName?: string | null;
    vaAccountName?: string | null;
  }
): Promise<void> {
  const now = new Date();
  await db
    .insert(merchantMarketCompliance)
    .values({
      merchantId,
      market: NIGERIA_MARKET,
      vaStatus: patch.vaStatus ?? null,
      vaAccountNumber: patch.vaAccountNumber ?? null,
      vaBankName: patch.vaBankName ?? null,
      vaAccountName: patch.vaAccountName ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [merchantMarketCompliance.merchantId, merchantMarketCompliance.market],
      set: {
        ...(patch.vaStatus !== undefined ? { vaStatus: patch.vaStatus } : {}),
        ...(patch.vaAccountNumber !== undefined ? { vaAccountNumber: patch.vaAccountNumber } : {}),
        ...(patch.vaBankName !== undefined ? { vaBankName: patch.vaBankName } : {}),
        ...(patch.vaAccountName !== undefined ? { vaAccountName: patch.vaAccountName } : {}),
        updatedAt: now,
      },
    });
}

export async function findMerchantIdByNigeriaVaAccountNumber(
  accountNumber: string
): Promise<string | null> {
  const acct = accountNumber.replace(/\s/g, "").trim();
  if (!acct) return null;

  const [row] = await db
    .select({ merchantId: merchantMarketCompliance.merchantId })
    .from(merchantMarketCompliance)
    .where(
      and(
        eq(merchantMarketCompliance.market, NIGERIA_MARKET),
        eq(merchantMarketCompliance.vaAccountNumber, acct)
      )
    )
    .limit(1);

  if (row?.merchantId) return row.merchantId;

  const [legacy] = await db
    .select({ id: merchants.id })
    .from(merchants)
    .where(eq(merchants.tekkoNgnVaAccountNumber, acct))
    .limit(1);

  return legacy?.id ?? null;
}
