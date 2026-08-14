const express = require("express");
const { listUsers, approveUser, setUserActive } = require("../controllers/users.controller");
const requireAuth = require("../middlewares/auth.middleware");
const requireRole = require("../middlewares/requireRole.middleware");

const router = express.Router();

router.use(requireAuth, requireRole("superadmin"));
router.get("/", listUsers);
router.put("/:id/approve", approveUser);
router.put("/:id/active", setUserActive);

module.exports = router;
