const axios = require("axios");

function authHeader() {
  const token = Buffer.from(`${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`).toString("base64");
  return `Basic ${token}`;
}

async function fetchUnansweredComments(siteUrl, postId) {
  const { data: allComments } = await axios.get(`${siteUrl}/wp-json/wp/v2/comments`, {
    params: { post: postId, per_page: 100, orderby: "date", order: "desc" },
    headers: { Authorization: authHeader() },
  });

  const repliedParentIds = new Set(allComments.filter((c) => c.parent !== 0).map((c) => c.parent));
  return allComments.filter((c) => c.parent === 0 && !repliedParentIds.has(c.id));
}

async function postReply(siteUrl, { postId, parentCommentId, content }) {
  await axios.post(
    `${siteUrl}/wp-json/wp/v2/comments`,
    { post: postId, parent: parentCommentId, content },
    { headers: { Authorization: authHeader(), "Content-Type": "application/json" } }
  );
}

module.exports = { fetchUnansweredComments, postReply };
