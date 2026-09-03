/**
 * PayOK rail availability — Bangladesh pause vs Brazil credentials.
 * Brazil uses the same PAYOK_* env as Bangladesh but is not gated by
 * BANGLADESH_PAYMENTS_DISABLED.
 */
import { isBangladeshPaymentsPaused } from "./bangladesh-rail-pause.js";
import {
  getDefaultPayokEnvironment,
  getPayokCallbackPublicKeys,
  getPayokConfigForEnvironment,
  type PayokCountryCode,
  type PayokEnvironment,
} from "../../services/domestic/bangladesh/provider/config.js";

export function isPayokCredentialsConfigured(
  environment: PayokEnvironment = getDefaultPayokEnvironment(),
  countryCode?: PayokCountryCode
): boolean {
  try {
    getPayokConfigForEnvironment(environment, countryCode ? { countryCode } : undefined);
    return true;
  } catch {
    return false;
  }
}

export function isPayokWebhookVerificationConfigured(): boolean {
  try {
    getPayokCallbackPublicKeys();
    return true;
  } catch {
    return false;
  }
}

export type PayokRailStartupSummary = {
  defaultEnvironment: PayokEnvironment;
  /** Bangladesh collect/payout create paths (webhooks still accept in-flight). */
  bangladeshCollectPayout: "enabled" | "paused";
  /** Brazil PIX create paths — independent of Bangladesh pause. */
  brazilCollectPayout: "ready" | "credentials_missing";
  /** Shared PayOK pay-in/payout webhook signature verification. */
  payokWebhooks: "ready" | "credentials_missing";
};

export function getPayokRailStartupSummary(): PayokRailStartupSummary {
  const defaultEnvironment = getDefaultPayokEnvironment();
  return {
    defaultEnvironment,
    bangladeshCollectPayout: isBangladeshPaymentsPaused() ? "paused" : "enabled",
    brazilCollectPayout: isPayokCredentialsConfigured(defaultEnvironment, "BR")
      ? "ready"
      : "credentials_missing",
    payokWebhooks: isPayokWebhookVerificationConfigured() ? "ready" : "credentials_missing",
  };
}
