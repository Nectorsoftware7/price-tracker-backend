const axios = require("axios");

const MODEL = process.env.OPENROUTER_MODEL || "nousresearch/hermes-3-llama-3.1-405b";

async function callHermes(systemPrompt, userPrompt, maxTokens = 150) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY missing in .env");

  const { data } = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.6,
    },
    { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } }
  );

  return data.choices[0].message.content.trim();
}

async function generateReply({ productName, reviewerName, reviewText, rating }) {
  const systemPrompt =
    "You are a polite, concise customer support agent replying to a product review " +
    "on our online store. Keep replies under 60 words, warm but professional, in the " +
    "same language the review was written in (Hindi/Hinglish/English). Thank the " +
    "customer, address anything specific they mentioned, and never make promises " +
    "about refunds/discounts. Do not sign off with a name.";

  const userPrompt =
    `Product: ${productName}\n` +
    `Reviewer: ${reviewerName || "Customer"}\n` +
    (rating ? `Rating: ${rating}/5\n` : "") +
    `Review: """${reviewText}"""\n\nWrite a short reply to this review.`;

  return callHermes(systemPrompt, userPrompt);
}

async function generateContactReply({ name, message }) {
  const systemPrompt =
    "You are a helpful customer support agent for an online store, replying by email " +
    "to a question submitted through the website's contact form. Answer clearly and " +
    "politely in the same language the question was written in (Hindi/Hinglish/English). " +
    "Keep it under 120 words. If the question needs specific order/account details, " +
    "pricing, discounts, bulk/wholesale quantities, or any policy you don't have " +
    "verified information about, say a team member will personally follow up with " +
    "them soon — do not guess, do not state or imply a discount/policy exists, and " +
    "do not claim you've already forwarded, shared, or escalated their request to " +
    "anyone (you haven't — only say a team member will reach out). Never invent " +
    "prices, policies, or promises you're not certain of. Write ONLY the reply body — " +
    "no subject line, no greeting like 'Dear X' (that's added separately), and no sign-off " +
    "(no 'Best regards', no team name).";

  const userPrompt = `Customer name: ${name || "Customer"}\nMessage: """${message}"""\n\nWrite a short email reply body.`;

  return callHermes(systemPrompt, userPrompt, 220);
}

module.exports = { generateReply, generateContactReply };
