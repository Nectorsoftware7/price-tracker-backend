const axios = require("axios");

const BASE_URL = "https://judge.me/api/v1";

async function fetchUnansweredReviews() {
  const apiToken = process.env.JUDGEME_API_TOKEN;
  const shopDomain = process.env.JUDGEME_SHOP_DOMAIN;

  const { data } = await axios.get(`${BASE_URL}/reviews`, {
    params: { api_token: apiToken, shop_domain: shopDomain, per_page: 50 },
  });

  return (data.reviews || []).filter((r) => !r.reply);
}

async function postReply(reviewId, replyText) {
  await axios.put(`${BASE_URL}/reviews/${reviewId}`, {
    api_token: process.env.JUDGEME_API_TOKEN,
    shop_domain: process.env.JUDGEME_SHOP_DOMAIN,
    reply: replyText,
  });
}

module.exports = { fetchUnansweredReviews, postReply };
