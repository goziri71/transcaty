/**
 * Merchant-safe rail labels for transaction list/detail (portal + /v1).
 * Maps internal `provider` DB values to region/product copy only — no vendor names.
 */

export type MerchantTransactionRail = "bangladesh" | "india" | "europe" | "internal" | "unknown";

export type MerchantTransactionRailPresentation = {
  currency: string;
  rail: MerchantTransactionRail;
  railLabel: string;
};

/** Persisted `metadata.tyltProduct` values that belong to the India TL Pay lane (not EUR). */
const INDIA_TYLT_PRODUCTS = new Set([
  "h2h_upi",
  "crossramp_upi",
  "cpg_payin",
  "cpg_payout",
  "internal_transfer",
]);

/** Reserved for the EUR lane when implemented (`tylt-eur-*` providers + metadata). */
const EUROPE_TYLT_PRODUCTS = new Set(["eur_payin", "eur_payout"]);

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
    case "tylt-eur-payin":
      return { rail: "europe", railLabel: "Europe pay-in" };
    case "tylt-eur-payout":
      return { rail: "europe", railLabel: "Europe payout" };
    case "internal-transfer":
      return { rail: "internal", railLabel: "Customer transfer" };
    case "internal-refund":
      return { rail: "internal", railLabel: "Customer refund" };
    default:
      if (provider.startsWith("tylt-eur")) {
        return { rail: "europe", railLabel: "Europe pay-in" };
      }
      if (provider.startsWith("tylt-")) {
        return { rail: "unknown", railLabel: "Cross-border" };
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
    if (meta.rail !== "tylt") return false;
    const product = typeof meta.tyltProduct === "string" ? meta.tyltProduct.trim() : "";
    return INDIA_TYLT_PRODUCTS.has(product);
  } catch {
    return false;
  }
}

function inferEuropeFromMetadata(metadata: string | null): boolean {
  if (!metadata?.trim()) return false;
  try {
    const meta = JSON.parse(metadata) as { rail?: unknown; tyltProduct?: unknown };
    if (meta.rail !== "tylt") return false;
    const product = typeof meta.tyltProduct === "string" ? meta.tyltProduct.trim() : "";
    return EUROPE_TYLT_PRODUCTS.has(product);
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

  if (inferEuropeFromMetadata(params.metadata ?? null)) {
    return { currency, rail: "europe", railLabel: "Europe" };
  }

  if (inferIndiaFromMetadata(params.metadata ?? null)) {
    return { currency, rail: "india", railLabel: "India" };
  }

  if (currency === "BDT") {
    return { currency, rail: "bangladesh", railLabel: "Bangladesh" };
  }

  if (currency === "EUR") {
    return { currency, rail: "europe", railLabel: "Europe" };
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
