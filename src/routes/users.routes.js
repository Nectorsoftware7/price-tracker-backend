const express = require("express");
const { listUsers, approveUser, setUserActive } = require("../controllers/users.controller");
const requireAuth = require("../middlewares/auth.middleware");
const requireRole = require("../middlewares/requireRole.middleware");

const router = express.Router();

// Read access (the user list itself) is also open to the read-only viewer role, so a
// demo account can see the full sidebar including this page — the actual privilege
// boundary (assigning roles, approving, activating/deactivating) stays superadmin-only.
router.use(requireAuth);
router.get("/", requireRole("superadmin", "viewer"), listUsers);
router.put("/:id/approve", requireRole("superadmin"), approveUser);
router.put("/:id/active", requireRole("superadmin"), setUserActive);

module.exports = router;
