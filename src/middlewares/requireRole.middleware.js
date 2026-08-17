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

// Use after requireAuth on any mutating route. "viewer" is a read-only role (given
// out for demo/review access) — it must still pass requireAuth normally so GET
// routes work, but every POST/PUT/DELETE route needs this to actually enforce
// "view only" server-side rather than just hiding the buttons in the UI.
function blockViewer(req, res, next) {
  if (req.user?.role === "viewer") return next(new ApiError(403, "This account is view-only"));
  next();
}

module.exports = requireRole;
module.exports.blockViewer = blockViewer;
