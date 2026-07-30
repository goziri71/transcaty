/**
 * Enforce HTTPS for merchant outbound webhook destinations.
 * Local/dev can opt into HTTP via ALLOW_HTTP_WEBHOOKS=true (ignored in production).
 */
export function assertHttpsWebhookUrl(
  raw: string | null | undefined
): { ok: true; url: string | null } | { ok: false; message: string } {
  if (raw == null || raw.trim() === "") {
    return { ok: true, url: null };
  }
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, message: "Invalid webhook URL" };
  }
  if (parsed.protocol === "https:") {
    return { ok: true, url: parsed.toString() };
  }
  const allowHttp =
    process.env.NODE_ENV !== "production" &&
    process.env.ALLOW_HTTP_WEBHOOKS?.trim().toLowerCase() === "true";
  if (parsed.protocol === "http:" && allowHttp) {
    return { ok: true, url: parsed.toString() };
  }
  return { ok: false, message: "Webhook URL must use HTTPS" };
}
