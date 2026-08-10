const axios = require("axios");

async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing in .env");
    return;
  }

  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

module.exports = { sendTelegramMessage };
