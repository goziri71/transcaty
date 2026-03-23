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
    }
  | {
      kind: "portal_login";
      to: string;
    }
  | {
      kind: "provider_login";
      to: string;
    }
  | {
      kind: "merchant_portal_payout";
      to: string;
      amount: string;
      transactionId: string;
      recipientMasked: string;
    };

export async function queueTransactionalEmail(payload: TransactionalEmailPayload): Promise<void> {
  console.log(`[email] Sending job to queue: kind=${payload.kind} to=${payload.to}`);
  await queue.send(TRANSACTIONAL_EMAIL_JOB, payload, {
    retryLimit: 5,
    retryDelay: 30,
  });
  console.log(`[email] Job queued successfully: kind=${payload.kind}`);
}

export async function deliverTransactionalEmail(payload: TransactionalEmailPayload): Promise<void> {
  const appName = process.env.EMAIL_APP_NAME?.trim() || "Transcaty";
  console.log(`[email] Worker processing: kind=${payload.kind} to=${payload.to}`);

  if (payload.kind === "portal_login") {
    const ok = await sendTransactionalEmail({
      to: payload.to,
      subject: `New login to your ${appName} merchant portal`,
      text: [
        `We detected a new login to your ${appName} merchant portal account.`,
        "",
        `If this was you, no action is needed.`,
        `If you did not log in, please change your password immediately.`,
      ].join("\n"),
      html: `
        <p>We detected a new login to your <strong>${appName}</strong> merchant portal account.</p>
        <p>If this was you, no action is needed.</p>
        <p>If you did not log in, please change your password immediately.</p>
      `.trim(),
    });
    if (!ok) throw new Error("portal_login email delivery failed");
    console.log(`[email] portal_login sent successfully to ${payload.to}`);
    return;
  }

  if (payload.kind === "provider_login") {
    const ok = await sendTransactionalEmail({
      to: payload.to,
      subject: `New login to your ${appName} provider dashboard`,
      text: [
        `We detected a new login to your ${appName} provider admin dashboard.`,
        "",
        `If this was you, no action is needed.`,
        `If you did not log in, please change your password immediately.`,
      ].join("\n"),
      html: `
        <p>We detected a new login to your <strong>${appName}</strong> provider admin dashboard.</p>
        <p>If this was you, no action is needed.</p>
        <p>If you did not log in, please change your password immediately.</p>
      `.trim(),
    });
    if (!ok) throw new Error("provider_login email delivery failed");
    console.log(`[email] provider_login sent successfully to ${payload.to}`);
    return;
  }

  if (payload.kind === "merchant_portal_payout") {
    const ok = await sendTransactionalEmail({
      to: payload.to,
      subject: `Payout initiated – ${appName}`,
      text: [
        `A payout of ${payload.amount} BDT has been initiated from your ${appName} account.`,
        "",
        `Transaction ID: ${payload.transactionId}`,
        `Recipient: ${payload.recipientMasked}`,
        "",
        `You will receive another notification when the payout completes.`,
      ].join("\n"),
      html: `
        <p>A payout of <strong>${payload.amount} BDT</strong> has been initiated from your <strong>${appName}</strong> account.</p>
        <p>Transaction ID: ${payload.transactionId}</p>
        <p>Recipient: ${payload.recipientMasked}</p>
        <p>You will receive another notification when the payout completes.</p>
      `.trim(),
    });
    if (!ok) throw new Error("merchant_portal_payout email delivery failed");
    console.log(`[email] merchant_portal_payout sent successfully to ${payload.to}`);
    return;
  }

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
