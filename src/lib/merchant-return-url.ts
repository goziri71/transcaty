/**
 * Validates merchant-supplied return URLs for PayOK redirect (customer browser after payment).
 * PayOK field limit ~200 chars; merchants never see PayOK — only this URL is forwarded.
 */
const PAYOK_RETURN_URL_MAX_LEN = 200;

export type ValidateReturnUrlResult =
  | { ok: true; normalized: string }
  | { ok: false; message: string };

/**
 * Require https, or http only for localhost-style dev URLs.
 * Rejects credentials, non-http(s) schemes, and excessive length.
 */
export function validateMerchantReturnUrl(raw: string): ValidateReturnUrlResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, message: "returnUrl is required" };
  }
  if (trimmed.length > PAYOK_RETURN_URL_MAX_LEN) {
    return {
      ok: false,
      message: `returnUrl must be at most ${PAYOK_RETURN_URL_MAX_LEN} characters (PayOK limit)`,
    };
  }

  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { ok: false, message: "returnUrl must be a valid absolute URL (e.g. https://yoursite.com/payment/done)" };
  }

  if (u.username || u.password) {
    return { ok: false, message: "returnUrl must not include userinfo" };
  }

  if (u.protocol === "https:") {
    return { ok: true, normalized: trimmed };
  }

  if (u.protocol === "http:") {
    const host = u.hostname.toLowerCase();
    const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
    if (local) {
      return { ok: true, normalized: trimmed };
    }
    return { ok: false, message: "returnUrl must use https (http is allowed only for localhost)" };
  }

  return { ok: false, message: "returnUrl must use http or https" };
}
