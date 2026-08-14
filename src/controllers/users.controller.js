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

module.exports = { listUsers, approveUser };
