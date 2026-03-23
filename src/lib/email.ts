/**
 * Transactional email: Resend, ZeptoMail (Zoho), or SMTP (nodemailer).
 * Configure one of: RESEND_API_KEY, ZEPTOMAIL_TOKEN, or SMTP_HOST + SMTP_USER + SMTP_PASS.
 */
import nodemailer from "nodemailer";
import { SendMailClient } from "zeptomail";
import { getSecret } from "./encryption.js";

export type SendEmailParams = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

function getFromAddress(): string | null {
  const from = getSecret("EMAIL_FROM", "EMAIL_FROM_ENC")?.trim();
  return from || null;
}

/** Parse "Name <email@domain.com>" or "email@domain.com" to { address, name } */
function parseFrom(from: string): { address: string; name: string } {
  const match = from.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) {
    return { address: match[2].trim(), name: match[1].trim() };
  }
  return { address: from.trim(), name: "noreply" };
}

/**
 * Returns true if email was accepted by provider; false if email is not configured or send failed.
 */
export async function sendTransactionalEmail(params: SendEmailParams): Promise<boolean> {
  const from = getFromAddress();
  if (!from) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "EMAIL_FROM not set; cannot send email",
        to: params.to,
      })
    );
    return false;
  }

  const zeptoToken = getSecret("ZEPTOMAIL_TOKEN", "ZEPTOMAIL_TOKEN_ENC")?.trim();
  if (zeptoToken) {
    try {
      const baseUrl = process.env.ZEPTOMAIL_URL?.trim() || "https://api.zeptomail.com/v1.1";
      const client = new SendMailClient({ url: baseUrl, token: zeptoToken });
      const parsed = parseFrom(from);
      await client.sendMail({
        from: { address: parsed.address, name: parsed.name },
        to: [{ email_address: { address: params.to, name: params.to.split("@")[0] } }],
        subject: params.subject,
        textbody: params.text,
        htmlbody: params.html ?? params.text.replace(/\n/g, "<br/>"),
      });
      return true;
    } catch (e) {
      console.error(
        JSON.stringify({
          level: "error",
          msg: "ZeptoMail send failed",
          error: e instanceof Error ? e.message : String(e),
          to: params.to,
        })
      );
      return false;
    }
  }

  const resendKey = getSecret("RESEND_API_KEY", "RESEND_API_KEY_ENC")?.trim();
  if (resendKey) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [params.to],
          subject: params.subject,
          text: params.text,
          html: params.html ?? params.text.replace(/\n/g, "<br/>"),
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        console.error(
          JSON.stringify({
            level: "error",
            msg: "Resend API error",
            status: res.status,
            body: body.slice(0, 500),
          })
        );
        return false;
      }
      return true;
    } catch (e) {
      console.error(
        JSON.stringify({
          level: "error",
          msg: "Resend fetch failed",
          error: e instanceof Error ? e.message : String(e),
        })
      );
      return false;
    }
  }

  const host = process.env.SMTP_HOST?.trim();
  const user = getSecret("SMTP_USER", "SMTP_USER_ENC")?.trim();
  const pass = getSecret("SMTP_PASS", "SMTP_PASS_ENC")?.trim();
  const port = Number(process.env.SMTP_PORT ?? "587");

  if (!host || !user || !pass) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "No email provider: set ZEPTOMAIL_TOKEN, RESEND_API_KEY, or SMTP_HOST/SMTP_USER/SMTP_PASS",
        to: params.to,
      })
    );
    return false;
  }

  try {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });
    await transporter.sendMail({
      from,
      to: params.to,
      subject: params.subject,
      text: params.text,
      html: params.html,
    });
    return true;
  } catch (e) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "SMTP send failed",
        error: e instanceof Error ? e.message : String(e),
      })
    );
    return false;
  }
}
