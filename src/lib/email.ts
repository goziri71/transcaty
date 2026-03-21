/**
 * Transactional email: Resend HTTP API or SMTP (nodemailer).
 * Configure one of: RESEND_API_KEY, or SMTP_HOST + SMTP_USER + SMTP_PASS.
 */
import nodemailer from "nodemailer";

export type SendEmailParams = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

function getFromAddress(): string | null {
  const from = process.env.EMAIL_FROM?.trim();
  return from || null;
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

  const resendKey = process.env.RESEND_API_KEY?.trim();
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
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  const port = Number(process.env.SMTP_PORT ?? "587");

  if (!host || !user || !pass) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "No email provider: set RESEND_API_KEY or SMTP_HOST/SMTP_USER/SMTP_PASS",
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
