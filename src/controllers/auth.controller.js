const bcrypt = require("bcryptjs");
const { OAuth2Client } = require("google-auth-library");
const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const { signToken } = require("../utils/jwt");
const asyncHandler = require("../utils/asyncHandler");

const googleClient = process.env.GOOGLE_CLIENT_ID ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID) : null;

const login = asyncHandler(async (req, res) => {
  const { username, password } = req.body;

  const user = await User.findByUsername(username);
  if (!user) throw new ApiError(401, "Invalid username or password");

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) throw new ApiError(401, "Invalid username or password");

  const token = signToken({ sub: user.id, username: user.username, role: user.role });
  res.json({ token, user: { _id: user.id, username: user.username, role: user.role } });
});

// "Sign in with Google" — the frontend gets an ID token from Google Identity Services
// and sends it here to be verified. We only ever look a user up by the email Google
// vouches for; there's no separate Google signup flow, so this only ever logs in an
// account whose username was already set to that exact email by an admin.
const googleLogin = asyncHandler(async (req, res) => {
  if (!googleClient) throw new ApiError(500, "Google login is not configured on the server");

  const { credential } = req.body;
  if (!credential) throw new ApiError(400, "Missing Google credential");

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch {
    throw new ApiError(401, "Invalid Google credential");
  }

  const user = await User.findByUsername(payload.email);
  if (!user) throw new ApiError(403, "This Google account isn't registered for dashboard access");

  const token = signToken({ sub: user.id, username: user.username, role: user.role });
  res.json({ token, user: { _id: user.id, username: user.username, role: user.role } });
});

const me = asyncHandler(async (req, res) => {
  res.json({ user: req.user });
});

module.exports = { login, googleLogin, me };
