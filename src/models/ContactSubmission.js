const { getPool } = require("../config/db");

function toApiShape(row) {
  return {
    _id: row.id,
    formTitle: row.form_title,
    siteName: row.site_name,
    siteUrl: row.site_url,
    platform: row.platform,
    name: row.name,
    email: row.email,
    phone: row.phone,
    message: row.message,
    aiReply: row.ai_reply,
    emailSent: Boolean(row.email_sent),
    emailError: row.email_error,
    manualReply: row.manual_reply,
    manualReplySentAt: row.manual_reply_sent_at,
    createdAt: row.created_at,
  };
}

async function create({ formTitle, siteName, siteUrl, platform, name, email, phone, message, aiReply, emailSent, emailError }) {
  const [result] = await getPool().query(
    `INSERT INTO contact_submissions (form_title, site_name, site_url, platform, name, email, phone, message, ai_reply, email_sent, email_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      formTitle || null,
      siteName || null,
      siteUrl || null,
      platform || null,
      name || null,
      email || null,
      phone || null,
      message || null,
      aiReply || null,
      emailSent ? 1 : 0,
      emailError || null,
    ]
  );
  return findById(result.insertId);
}

async function findById(id) {
  const [rows] = await getPool().query("SELECT * FROM contact_submissions WHERE id = ?", [id]);
  return rows[0] ? toApiShape(rows[0]) : null;
}

async function findAll(limit = 200) {
  const [rows] = await getPool().query("SELECT * FROM contact_submissions ORDER BY created_at DESC LIMIT ?", [limit]);
  return rows.map(toApiShape);
}

async function recordManualReply(id, replyText) {
  await getPool().query("UPDATE contact_submissions SET manual_reply = ?, manual_reply_sent_at = NOW() WHERE id = ?", [
    replyText,
    id,
  ]);
  return findById(id);
}

module.exports = { create, findById, findAll, recordManualReply };
