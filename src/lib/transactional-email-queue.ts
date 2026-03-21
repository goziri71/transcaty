/**
 * Async email delivery via pg-boss (does not block HTTP handlers).
 */
import { queue } from "./queue.js";
import { sendTransactionalEmail } from "./email.js";

export const TRANSACTIONAL_EMAIL_JOB = "transactional-email";

export type TransactionalEmailPayload =
  | {
      kind: "portal_password_reset";
      to: string;
      resetUrl: string;
    }
  | {
      kind: "provider_password_reset";
      to: string;
      resetUrl: string;
    };

export async function queueTransactionalEmail(payload: TransactionalEmailPayload): Promise<void> {
  await queue.send(TRANSACTIONAL_EMAIL_JOB, payload, {
    retryLimit: 5,
    retryDelay: 30,
  });
}

export async function deliverTransactionalEmail(payload: TransactionalEmailPayload): Promise<void> {
  const appName = process.env.EMAIL_APP_NAME?.trim() || "Transcaty";

  if (payload.kind === "portal_password_reset") {
    const ok = await sendTransactionalEmail({
      to: payload.to,
      subject: `Reset your ${appName} merchant portal password`,
      text: [
        `We received a request to reset your ${appName} merchant portal password.`,
        "",
        `Open this link to choose a new password (it expires soon):`,
        payload.resetUrl,
        "",
        `If you did not request this, you can ignore this email.`,
      ].join("\n"),
      html: `
        <p>We received a request to reset your <strong>${appName}</strong> merchant portal password.</p>
        <p><a href="${payload.resetUrl}">Reset your password</a></p>
        <p>If you did not request this, you can ignore this email.</p>
      `.trim(),
    });
    if (!ok) throw new Error("portal_password_reset email delivery failed");
    return;
  }

  const ok = await sendTransactionalEmail({
    to: payload.to,
    subject: `Reset your ${appName} provider admin password`,
    text: [
      `We received a request to reset your ${appName} provider admin password.`,
      "",
      `Open this link to choose a new password (it expires soon):`,
      payload.resetUrl,
      "",
      `If you did not request this, you can ignore this email.`,
    ].join("\n"),
    html: `
      <p>We received a request to reset your <strong>${appName}</strong> provider admin password.</p>
      <p><a href="${payload.resetUrl}">Reset your password</a></p>
      <p>If you did not request this, you can ignore this email.</p>
    `.trim(),
  });
  if (!ok) throw new Error("provider_password_reset email delivery failed");
}
