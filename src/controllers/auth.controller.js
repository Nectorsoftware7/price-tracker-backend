const bcrypt = require("bcryptjs");
const { OAuth2Client } = require("google-auth-library");
const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const { signToken } = require("../utils/jwt");
const asyncHandler = require("../utils/asyncHandler");

const googleClient = process.env.GOOGLE_CLIENT_ID ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID) : null;

// Distinct messages the frontend matches on to show a clean screen instead of a
// generic login error.
const PENDING_REVIEW = "ACCOUNT_PENDING_REVIEW";
const ACCOUNT_SUSPENDED = "ACCOUNT_SUSPENDED";

const login = asyncHandler(async (req, res) => {
  const { username, password } = req.body;

  const user = await User.findByUsername(username);
  if (!user || !user.password_hash) throw new ApiError(401, "Invalid username or password");

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) throw new ApiError(401, "Invalid username or password");
  if (!user.active) throw new ApiError(403, ACCOUNT_SUSPENDED);
  if (user.status !== "approved" || !user.role) throw new ApiError(403, PENDING_REVIEW);

  const token = signToken({ sub: user.id, username: user.username, role: user.role });
  res.json({ token, user: { _id: user.id, username: user.username, role: user.role } });
});

// "Sign in with Google" — the frontend gets an ID token from Google Identity Services
// and sends it here to be verified. A first-time Google sign-in for an email we don't
// recognize self-registers a pending account (no role yet) instead of rejecting it
// outright, so a superadmin can review it from the Users page and assign it a role.
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

  let user = await User.findByUsername(payload.email);
  if (!user) {
    user = await User.create({ username: payload.email, passwordHash: null, role: null, status: "pending" });
  }

  if (!user.active) throw new ApiError(403, ACCOUNT_SUSPENDED);
  if (user.status !== "approved" || !user.role) throw new ApiError(403, PENDING_REVIEW);

  const token = signToken({ sub: user.id, username: user.username, role: user.role });
  res.json({ token, user: { _id: user.id, username: user.username, role: user.role } });
});

const me = asyncHandler(async (req, res) => {
  res.json({ user: req.user });
});

module.exports = { login, googleLogin, me };
