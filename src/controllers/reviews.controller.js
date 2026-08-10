const Review = require("../models/Review");
const WpPost = require("../models/WpPost");
const { runAutoReply } = require("../jobs/autoReply");
const asyncHandler = require("../utils/asyncHandler");

const listReviews = asyncHandler(async (req, res) => {
  res.json(await Review.findAll(200));
});

const runNow = asyncHandler(async (req, res) => {
  await runAutoReply();
  res.json({ ok: true });
});

const listWpPosts = asyncHandler(async (req, res) => {
  res.json(await WpPost.findAll());
});

const createWpPost = asyncHandler(async (req, res) => {
  const post = await WpPost.create(req.body);
  res.status(201).json(post);
});

const deleteWpPost = asyncHandler(async (req, res) => {
  await WpPost.remove(req.params.id);
  res.status(204).end();
});

module.exports = { listReviews, runNow, listWpPosts, createWpPost, deleteWpPost };
