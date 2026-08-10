const WpPost = require("../models/WpPost");
const Review = require("../models/Review");
const { generateReply } = require("../services/hermes");
const wordpress = require("../services/wordpress");
const judgeme = require("../services/judgeme");
const { sendTelegramMessage } = require("../services/telegram");

async function handleWordPress() {
  const posts = await WpPost.findAll();

  for (const { siteUrl, postId, productName } of posts) {
    let comments;
    try {
      comments = await wordpress.fetchUnansweredComments(siteUrl, postId);
    } catch (err) {
      console.error(`Failed to fetch WP comments for post ${postId}:`, err.message);
      continue;
    }

    for (const comment of comments) {
      const externalId = `${postId}:${comment.id}`;
      const exists = await Review.findOne("wordpress", externalId);
      if (exists) continue;

      const reviewText = comment.content.rendered.replace(/<[^>]+>/g, "");

      try {
        const replyText = await generateReply({
          productName,
          reviewerName: comment.author_name,
          reviewText,
        });

        await wordpress.postReply(siteUrl, { postId, parentCommentId: comment.id, content: replyText });

        await Review.create({
          source: "wordpress",
          externalId,
          productName,
          reviewerName: comment.author_name,
          reviewText,
          replyText,
          repliedAt: new Date(),
        });

        await sendTelegramMessage(
          `💬 Auto-replied (WordPress)\n\n<b>${productName}</b>\nComment: "${reviewText}"\n\nReply: "${replyText}"`
        );
      } catch (err) {
        console.error(`Failed to reply to WP comment ${comment.id}:`, err.message);
      }
    }
  }
}

async function handleShopify() {
  let reviews;
  try {
    reviews = await judgeme.fetchUnansweredReviews();
  } catch (err) {
    console.error("Failed to fetch Judge.me reviews:", err.message);
    return;
  }

  for (const review of reviews) {
    const externalId = String(review.id);
    const exists = await Review.findOne("judgeme", externalId);
    if (exists) continue;

    const productName = review.product_title || review.product_handle || "the product";

    try {
      const replyText = await generateReply({
        productName,
        reviewerName: review.reviewer?.name,
        reviewText: review.body,
        rating: review.rating,
      });

      await judgeme.postReply(review.id, replyText);

      await Review.create({
        source: "judgeme",
        externalId,
        productName,
        reviewerName: review.reviewer?.name,
        rating: review.rating,
        reviewText: review.body,
        replyText,
        repliedAt: new Date(),
      });

      await sendTelegramMessage(
        `💬 Auto-replied (Shopify/Judge.me)\n\n<b>${productName}</b>\nReview (${review.rating}/5): "${review.body}"\n\nReply: "${replyText}"`
      );
    } catch (err) {
      console.error(`Failed to reply to Judge.me review ${review.id}:`, err.message);
    }
  }
}

async function runAutoReply() {
  // Each platform's failure (bad credentials, API down) shouldn't stop the other
  // from running — this endpoint is hit by an external cron trigger, so one broken
  // integration crashing the whole call would silently take auto-reply offline
  // entirely instead of just for that platform.
  try {
    await handleWordPress();
  } catch (err) {
    console.error("WordPress auto-reply run failed:", err.message);
  }
  try {
    await handleShopify();
  } catch (err) {
    console.error("Shopify auto-reply run failed:", err.message);
  }
}

module.exports = { runAutoReply };
