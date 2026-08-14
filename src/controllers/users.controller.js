const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../utils/asyncHandler");

const listUsers = asyncHandler(async (req, res) => {
  res.json(await User.findAll());
});

const approveUser = asyncHandler(async (req, res) => {
  const { role } = req.body;
  if (!["admin", "superadmin"].includes(role)) throw new ApiError(400, "role must be 'admin' or 'superadmin'");

  const user = await User.findById(req.params.id);
  if (!user) throw new ApiError(404, "User not found");

  res.json(await User.approve(user.id, role));
});

const setUserActive = asyncHandler(async (req, res) => {
  const { active } = req.body;
  if (typeof active !== "boolean") throw new ApiError(400, "active must be true or false");

  const user = await User.findById(req.params.id);
  if (!user) throw new ApiError(404, "User not found");
  if (user.id === req.user.sub) throw new ApiError(400, "You can't change your own active status");

  res.json(await User.setActive(user.id, active));
});

module.exports = { listUsers, approveUser, setUserActive };
