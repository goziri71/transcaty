/**
 * Async email delivery via pg-boss (does not block HTTP handlers).
 */
import { queue } from "./queue.js";
import { sendTransactionalEmail } from "./email.js";

export const TRANSACTIONAL_EMAIL_JOB = "transactional-email";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatLoginTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      hour12: true,
    });
  } catch {
    return iso;
  }
}

export type TransactionalEmailPayload =
  | {
      kind: "portal_payout_pin_reset";
      to: string;
      resetUrl: string;
    }
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
      ip: string;
      timestamp: string;
      changePasswordUrl: string;
    }
  | {
      kind: "provider_login";
      to: string;
      ip: string;
      timestamp: string;
      changePasswordUrl: string;
    }
  | {
      kind: "merchant_portal_payout";
      to: string;
      amount: string;
      transactionId: string;
      recipientMasked: string;
    }
  | {
      kind: "merchant_payment_event";
      to: string;
      eventLabel: string;
      statusWord: string;
      transactionId: string;
      amount: string;
      paidAmount?: string;
      platformOrderId: string | null;
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
  const appName = process.env.EMAIL_APP_NAME?.trim() || "Transacty";
  console.log(`[email] Worker processing: kind=${payload.kind} to=${payload.to}`);

  if (payload.kind === "portal_login") {
    const whenFormatted = formatLoginTimestamp(payload.timestamp);
    const ok = await sendTransactionalEmail({
      to: payload.to,
      subject: `New login to your ${appName} merchant portal`,
      text: [
        `We detected a new login to your ${appName} merchant portal account.`,
        "",
        `When: ${whenFormatted}`,
        `IP address: ${payload.ip}`,
        "",
        `If this was you, no action is needed.`,
        `If you did not log in, secure your account: ${payload.changePasswordUrl}`,
      ].join("\n"),
      html: `
        <div style="font-family: system-ui, sans-serif; max-width: 480px; padding: 24px;">
          <h2 style="margin: 0 0 16px; font-size: 18px;">New login to your ${appName} account</h2>
          <p style="margin: 0 0 16px; color: #374151;">We detected a new login to your merchant portal.</p>
          <div style="background: #f3f4f6; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <p style="margin: 0 0 8px; font-size: 14px;"><strong>When:</strong> ${escapeHtml(whenFormatted)}</p>
            <p style="margin: 0; font-size: 14px;"><strong>IP address:</strong> ${escapeHtml(payload.ip)}</p>
          </div>
          <p style="margin: 16px 0; color: #374151;">If this was you, no action is needed.</p>
          <p style="margin: 0 0 16px; color: #374151;">If you did not log in, secure your account immediately:</p>
          <p style="margin: 0;"><a href="${escapeHtml(payload.changePasswordUrl)}" style="display: inline-block; background: #dc2626; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500;">Change password</a></p>
        </div>
      `.trim(),
    });
    if (!ok) throw new Error("portal_login email delivery failed");
    console.log(`[email] portal_login sent successfully to ${payload.to}`);
    return;
  }

  if (payload.kind === "provider_login") {
    const whenFormatted = formatLoginTimestamp(payload.timestamp);
    const ok = await sendTransactionalEmail({
      to: payload.to,
      subject: `New login to your ${appName} provider dashboard`,
      text: [
        `We detected a new login to your ${appName} provider admin dashboard.`,
        "",
        `When: ${whenFormatted}`,
        `IP address: ${payload.ip}`,
        "",
        `If this was you, no action is needed.`,
        `If you did not log in, secure your account: ${payload.changePasswordUrl}`,
      ].join("\n"),
      html: `
        <div style="font-family: system-ui, sans-serif; max-width: 480px; padding: 24px;">
          <h2 style="margin: 0 0 16px; font-size: 18px;">New login to your ${appName} dashboard</h2>
          <p style="margin: 0 0 16px; color: #374151;">We detected a new login to your provider admin dashboard.</p>
          <div style="background: #f3f4f6; padding: 16px; border-radius: 8px; margin: 16px 0;">
            <p style="margin: 0 0 8px; font-size: 14px;"><strong>When:</strong> ${escapeHtml(whenFormatted)}</p>
            <p style="margin: 0; font-size: 14px;"><strong>IP address:</strong> ${escapeHtml(payload.ip)}</p>
          </div>
          <p style="margin: 16px 0; color: #374151;">If this was you, no action is needed.</p>
          <p style="margin: 0 0 16px; color: #374151;">If you did not log in, secure your account immediately:</p>
          <p style="margin: 0;"><a href="${escapeHtml(payload.changePasswordUrl)}" style="display: inline-block; background: #dc2626; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500;">Change password</a></p>
        </div>
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

  if (payload.kind === "merchant_payment_event") {
    const subject =
      payload.statusWord === "completed"
        ? `${payload.eventLabel} completed – ${appName}`
        : `${payload.eventLabel} failed – ${appName}`;
    const amountLine =
      payload.paidAmount && payload.eventLabel === "Pay-in"
        ? `Amount: ${payload.amount} (paid: ${payload.paidAmount})`
        : `Amount: ${payload.amount}`;
    const ok = await sendTransactionalEmail({
      to: payload.to,
      subject,
      text: [
        `Your ${payload.eventLabel.toLowerCase()} has ${payload.statusWord}.`,
        "",
        amountLine,
        `Transaction ID: ${payload.transactionId}`,
        payload.platformOrderId ? `Platform order: ${payload.platformOrderId}` : "",
        "",
        `View details in your ${appName} merchant portal.`,
      ]
        .filter(Boolean)
        .join("\n"),
      html: `
        <div style="font-family: system-ui, sans-serif; max-width: 480px; padding: 24px;">
          <h2 style="margin: 0 0 12px; font-size: 18px;">${escapeHtml(payload.eventLabel)} ${escapeHtml(payload.statusWord)}</h2>
          <p style="margin: 0 0 8px; color: #374151;">${escapeHtml(amountLine)}</p>
          <p style="margin: 0 0 8px; font-size: 14px; color: #6b7280;">Transaction: ${escapeHtml(payload.transactionId)}</p>
          ${payload.platformOrderId ? `<p style="margin: 0 0 16px; font-size: 14px; color: #6b7280;">Platform order: ${escapeHtml(payload.platformOrderId)}</p>` : ""}
          <p style="margin: 16px 0 0; color: #374151;">Check your merchant portal for the full ledger and reconciliation report.</p>
        </div>
      `.trim(),
    });
    if (!ok) throw new Error("merchant_payment_event email delivery failed");
    return;
  }

  if (payload.kind === "portal_payout_pin_reset") {
    const ok = await sendTransactionalEmail({
      to: payload.to,
      subject: `Reset your ${appName} merchant payout PIN`,
      text: [
        `We received a request to reset your ${appName} merchant payout PIN.`,
        "",
        `Sign in to the merchant dashboard, complete MFA verification, then open this link:`,
        payload.resetUrl,
        "",
        `The link expires soon. If you did not request this, ignore this email and contact support.`,
      ].join("\n"),
      html: `
        <p>We received a request to reset your <strong>${appName}</strong> merchant payout PIN.</p>
        <p>Sign in, verify with your authenticator app, then complete the reset:</p>
        <p><a href="${payload.resetUrl}">Reset payout PIN</a></p>
        <p>If you did not request this, ignore this email.</p>
      `.trim(),
    });
    if (!ok) throw new Error("portal_payout_pin_reset email delivery failed");
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
