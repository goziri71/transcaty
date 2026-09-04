/** Mask shown in portal/provider API key lists (matches suffix from create response). */
export function maskMerchantApiKey(keyHint: string | null | undefined): string {
  const hint = keyHint?.trim();
  if (hint && hint.length > 0) {
    return "••••••••" + hint.slice(-8);
  }
  // Legacy rows created before key_hint existed — no reliable suffix.
  return "transacty_••••••••";
}

/** Persisted hint: last 8 characters of the one-time-shown API key. */
export function merchantApiKeyHint(apiKey: string): string {
  return apiKey.slice(-8);
}
