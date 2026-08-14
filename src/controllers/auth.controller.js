const bcrypt = require("bcryptjs");
const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const { signToken } = require("../utils/jwt");
const asyncHandler = require("../utils/asyncHandler");

const login = asyncHandler(async (req, res) => {
  const { username, password } = req.body;

  const user = await User.findByUsername(username);
  if (!user) throw new ApiError(401, "Invalid username or password");

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) throw new ApiError(401, "Invalid username or password");

  const token = signToken({ sub: user.id, username: user.username, role: user.role });
  res.json({ token, user: { _id: user.id, username: user.username, role: user.role } });
});

const me = asyncHandler(async (req, res) => {
  res.json({ user: req.user });
});

module.exports = { login, me };
