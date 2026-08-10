const nodemailer = require("nodemailer");

let transporter;

function getTransporter() {
  if (transporter) return transporter;

  const port = Number(process.env.SMTP_PORT) || 465;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port,
    // 465 is implicit TLS (secure: true); 587 is STARTTLS, which nodemailer handles
    // automatically over a plain connection when secure is false. Hardcoding
    // secure: true broke port 587 — some hosts (e.g. Render) block outbound 465.
    secure: port === 465,
    connectionTimeout: 10_000,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
  });
  return transporter;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Turns a plain AI reply into a simple branded HTML email. Kept intentionally minimal
// (no external assets/fonts) so it renders consistently across email clients.
function buildReplyEmailHtml({ storeName, storeUrl, customerName, replyText }) {
  const paragraphs = replyText
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px;">${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`)
    .join("");

  return `
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
            <tr>
              <td style="background:#111827;padding:20px 28px;">
                <span style="color:#ffffff;font-size:18px;font-weight:bold;">${escapeHtml(storeName || "Customer Support")}</span>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;color:#1f2937;font-size:15px;line-height:1.6;">
                <p style="margin:0 0 16px;">Hi ${escapeHtml(customerName || "there")},</p>
                ${paragraphs}
                <p style="margin:24px 0 0;color:#6b7280;font-size:13px;">
                  This is an automated reply. If you need further help, just reply to this email.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 28px;background:#f9fafb;border-top:1px solid #e5e7eb;">
                <span style="color:#9ca3af;font-size:12px;">
                  ${escapeHtml(storeName || "")}${storeUrl ? ` &middot; <a href="${escapeHtml(storeUrl)}" style="color:#9ca3af;">${escapeHtml(storeUrl)}</a>` : ""}
                </span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function sendReplyEmail({ to, subject, text, storeName, storeUrl, customerName }) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASSWORD) {
    throw new Error("SMTP_USER / SMTP_PASSWORD missing in .env");
  }

  await getTransporter().sendMail({
    from: `"${storeName || process.env.SMTP_FROM_NAME || "Support"}" <${process.env.SMTP_USER}>`,
    to,
    subject,
    text,
    html: buildReplyEmailHtml({ storeName, storeUrl, customerName, replyText: text }),
  });
}

module.exports = { sendReplyEmail };
