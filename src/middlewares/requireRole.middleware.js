const ApiError = require("../utils/ApiError");

// Use after requireAuth. Approving/assigning roles to other accounts is a real
// privilege boundary, unlike the page-visibility split enforced only in the frontend
// for Products/etc — this one is checked server-side too.
function requireRole(...allowedRoles) {
  return function (req, res, next) {
    if (!allowedRoles.includes(req.user?.role)) return next(new ApiError(403, "Forbidden"));
    next();
  };
}

module.exports = requireRole;
