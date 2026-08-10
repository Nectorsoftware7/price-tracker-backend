const ApiError = require("../utils/ApiError");
const { verifyToken } = require("../utils/jwt");

// Protects dashboard-facing routes with a Bearer JWT. Never apply this to the
// wordpress-webhook / shopify-proxy endpoints — those are called by external
// platforms and are authenticated by their own shared-secret / HMAC checks instead.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return next(new ApiError(401, "Missing or invalid Authorization header"));

  try {
    req.user = verifyToken(token);
    next();
  } catch {
    next(new ApiError(401, "Invalid or expired token"));
  }
}

module.exports = requireAuth;
