const ApiError = require("../utils/ApiError");
const { verifyToken } = require("../utils/jwt");
const User = require("../models/User");

// Distinct messages the frontend matches on — kept identical to the ones the login
// controller throws, so both paths produce the same clean "under review"/"suspended"
// screen instead of a generic error.
const ACCOUNT_SUSPENDED = "ACCOUNT_SUSPENDED";
const PENDING_REVIEW = "ACCOUNT_PENDING_REVIEW";

// Protects dashboard-facing routes with a Bearer JWT. Never apply this to the
// wordpress-webhook / shopify-proxy endpoints — those are called by external
// platforms and are authenticated by their own shared-secret / HMAC checks instead.
//
// Also re-checks the account's current active/status in the DB on every request, not
// just at login — otherwise a superadmin deactivating someone wouldn't take effect
// until their existing JWT (issued at login, valid up to JWT_EXPIRES_IN) expired on
// its own, which defeats the point of an immediate suspension.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return next(new ApiError(401, "Missing or invalid Authorization header"));

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    return next(new ApiError(401, "Invalid or expired token"));
  }

  try {
    const user = await User.findById(payload.sub);
    if (!user) return next(new ApiError(401, "Invalid or expired token"));
    if (!user.active) return next(new ApiError(403, ACCOUNT_SUSPENDED));
    if (user.status !== "approved" || !user.role) return next(new ApiError(403, PENDING_REVIEW));
  } catch (err) {
    return next(err);
  }

  req.user = payload;
  next();
}

module.exports = requireAuth;
