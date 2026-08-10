const ContactSubmission = require("../models/ContactSubmission");
const { generateContactReply } = require("../services/hermes");
const { sendReplyEmail } = require("../services/mailer");
const { sendTelegramMessage } = require("../services/telegram");
const { verifyProxySignature } = require("../services/shopifyProxyVerify");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");

// Common field name variants across form builders (Contact Form 7, Shopify's built-in form, etc).
function pick(fields, ...keys) {
  for (const key of keys) {
    if (fields[key]) return fields[key];
  }
  return null;
}

// Fallback for when the exact field name isn't one of our known variants: match by
// what the field name *contains*, since every site names its fields differently
// (e.g. "tel-349", "contact[Phone number]", "your-mobile-no").
function pickByPattern(fields, pattern) {
  for (const [key, value] of Object.entries(fields)) {
    if (pattern.test(key) && value) return value;
  }
  return null;
}

async function processSubmission({ formTitle, siteName, siteUrl, platform, fields }) {
  const name = pick(fields, "your-name", "name") || pickByPattern(fields, /name/i);
  const email = pick(fields, "your-email", "email") || pickByPattern(fields, /email|mail/i);
  const phone = pick(fields, "your-phone", "phone") || pickByPattern(fields, /phone|tel|mobile/i);
  const message =
    pick(fields, "your-message", "message", "your-question") || pickByPattern(fields, /message|question|comment|textarea/i);

  console.log(`Contact form submission (${formTitle}). Raw fields:`, JSON.stringify(fields));
  console.log("Parsed ->", { name, email, phone, message });

  let aiReply = null;
  let emailSent = false;
  let emailError = null;

  try {
    if (message) {
      aiReply = await generateContactReply({ name, message });

      if (email) {
        try {
          await sendReplyEmail({
            to: email,
            subject: `Re: your message to ${siteName || "us"}`,
            text: aiReply,
            storeName: siteName,
            storeUrl: siteUrl,
            customerName: name,
          });
          emailSent = true;
        } catch (err) {
          emailError = err.message;
        }
      }
    }
  } catch (err) {
    emailError = err.message;
  }

  await ContactSubmission.create({ formTitle, siteName, siteUrl, platform, name, email, phone, message, aiReply, emailSent, emailError });

  await sendTelegramMessage(
    `📝 <b>New contact form submission</b>\n\n` +
      `Website: ${siteName || "—"}${siteUrl ? ` (${siteUrl})` : ""}\n` +
      `Name: ${name || "—"}\n` +
      `Email: ${email || "—"}\n` +
      `Phone: ${phone || "—"}\n` +
      `Message: ${message || "—"}\n\n` +
      (aiReply ? `🤖 AI reply${emailSent ? " (emailed)" : emailError ? ` (email failed: ${emailError})` : ""}:\n${aiReply}` : "No message field found — no reply generated")
  );

  return { aiReply, emailSent };
}

const listSubmissions = asyncHandler(async (req, res) => {
  res.json(await ContactSubmission.findAll(200));
});

// Manually send (or re-send) a reply to a submission from the dashboard — either to
// tweak the AI's wording before it goes out, or to answer something the AI couldn't.
const manualReply = asyncHandler(async (req, res) => {
  const { message } = req.body;
  if (!message) throw new ApiError(400, "message is required");

  const submission = await ContactSubmission.findById(req.params.id);
  if (!submission) throw new ApiError(404, "Not found");
  if (!submission.email) throw new ApiError(400, "This submission has no email address to reply to");

  await sendReplyEmail({
    to: submission.email,
    subject: `Re: your message to ${submission.siteName || "us"}`,
    text: message,
    storeName: submission.siteName,
    storeUrl: submission.siteUrl,
    customerName: submission.name,
  });

  const updated = await ContactSubmission.recordManualReply(req.params.id, message);

  await sendTelegramMessage(`✍️ <b>Manual reply sent</b>\n\nTo: ${submission.name || submission.email}\n${message}`);

  res.json(updated);
});

// Called by a PHP snippet on the WordPress site (hooked into wpcf7_mail_sent) whenever
// a visitor submits the Contact Form 7 form. Requires a shared secret since this
// endpoint is reachable from the public internet once deployed.
const wordpressWebhook = asyncHandler(async (req, res) => {
  const expectedSecret = process.env.CF7_WEBHOOK_SECRET;
  if (expectedSecret && req.headers["x-form-secret"] !== expectedSecret) {
    throw new ApiError(401, "Invalid or missing form secret");
  }

  const { formTitle, siteName, siteUrl, fields } = req.body;
  if (!fields || typeof fields !== "object") throw new ApiError(400, "fields (object) is required");

  const result = await processSubmission({ formTitle, siteName, siteUrl, platform: "woocommerce", fields });
  res.json({ ok: true, ...result });
});

// Called via Shopify's App Proxy (kobralabs.com/apps/<subpath>) whenever the storefront
// contact form is submitted. Shopify signs every proxied request with the app's client
// secret, so no shared secret needs to travel through client-side JS — we verify the
// signature Shopify attaches instead.
const shopifyProxy = asyncHandler(async (req, res) => {
  if (!verifyProxySignature(req.query)) throw new ApiError(401, "Invalid proxy signature");

  const { formTitle, siteName, siteUrl, fields } = req.body;
  if (!fields || typeof fields !== "object") throw new ApiError(400, "fields (object) is required");

  const result = await processSubmission({ formTitle, siteName, siteUrl, platform: "shopify", fields });
  res.json({ ok: true, ...result });
});

// Called directly from a <script> tag embedded in the Shopify theme (not via App
// Proxy — no App Proxy was ever actually configured for this store). Protected by
// the same shared-secret pattern as the WordPress webhook, since the request comes
// straight from the customer's browser rather than through a Shopify-signed proxy.
const shopifyDirect = asyncHandler(async (req, res) => {
  const expectedSecret = process.env.CF7_WEBHOOK_SECRET;
  if (expectedSecret && req.headers["x-form-secret"] !== expectedSecret) {
    throw new ApiError(401, "Invalid or missing form secret");
  }

  const { formTitle, siteName, siteUrl, fields } = req.body;
  if (!fields || typeof fields !== "object") throw new ApiError(400, "fields (object) is required");

  const result = await processSubmission({ formTitle, siteName, siteUrl, platform: "shopify", fields });
  res.json({ ok: true, ...result });
});

module.exports = { listSubmissions, manualReply, wordpressWebhook, shopifyProxy, shopifyDirect };
