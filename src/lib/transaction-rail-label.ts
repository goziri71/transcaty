/**
 * Merchant-safe rail labels for transaction list/detail (portal + /v1).
 * Maps internal `provider` DB values to region/product copy only — no vendor names.
 */

export type MerchantTransactionRail = "bangladesh" | "india" | "internal" | "unknown";

export type MerchantTransactionRailPresentation = {
  currency: string;
  rail: MerchantTransactionRail;
  railLabel: string;
};

function labelFromProvider(provider: string): Pick<MerchantTransactionRailPresentation, "rail" | "railLabel"> | null {
  switch (provider) {
    case "payok-bd-payin":
      return { rail: "bangladesh", railLabel: "Bangladesh pay-in" };
    case "payok-bd-payout":
      return { rail: "bangladesh", railLabel: "Bangladesh payout" };
    case "tylt-h2h-upi":
      return { rail: "india", railLabel: "India UPI (H2H)" };
    case "tylt-cpg-payin":
      return { rail: "india", railLabel: "India crypto pay-in" };
    case "tylt-cpg-payout":
      return { rail: "india", railLabel: "India crypto payout" };
    case "tylt-crossramp":
      return { rail: "india", railLabel: "India UPI" };
    case "tylt-internal":
      return { rail: "india", railLabel: "India internal transfer" };
    case "internal-transfer":
      return { rail: "internal", railLabel: "Customer transfer" };
    case "internal-refund":
      return { rail: "internal", railLabel: "Customer refund" };
    default:
      if (provider.startsWith("tylt-")) {
        return { rail: "india", railLabel: "India" };
      }
      if (provider.startsWith("payok")) {
        return { rail: "bangladesh", railLabel: "Bangladesh" };
      }
      return null;
  }
}

function inferIndiaFromMetadata(metadata: string | null): boolean {
  if (!metadata?.trim()) return false;
  try {
    const meta = JSON.parse(metadata) as { rail?: unknown; tyltProduct?: unknown };
    if (meta.rail === "tylt") return true;
    return typeof meta.tyltProduct === "string" && meta.tyltProduct.trim().length > 0;
  } catch {
    return false;
  }
}

export function presentTransactionRail(params: {
  provider: string | null;
  currency: string;
  metadata?: string | null;
}): MerchantTransactionRailPresentation {
  const currency = params.currency?.trim() || "—";
  const provider = params.provider?.trim() || null;

  if (provider) {
    const fromProvider = labelFromProvider(provider);
    if (fromProvider) {
      return { currency, ...fromProvider };
    }
  }

  if (inferIndiaFromMetadata(params.metadata ?? null)) {
    return { currency, rail: "india", railLabel: "India" };
  }

  if (currency === "BDT") {
    return { currency, rail: "bangladesh", railLabel: "Bangladesh" };
  }

  if (currency === "INR" || currency === "USDT") {
    return {
      currency,
      rail: "india",
      railLabel: currency === "INR" ? "India UPI" : "India",
    };
  }

  return { currency, rail: "unknown", railLabel: "Other" };
}
