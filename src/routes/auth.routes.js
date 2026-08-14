const express = require("express");
const { login, googleLogin, me } = require("../controllers/auth.controller");
const { validateLogin } = require("../validators/auth.validator");
const requireAuth = require("../middlewares/auth.middleware");

const router = express.Router();

router.post("/login", validateLogin, login);
router.post("/google", googleLogin);
router.get("/me", requireAuth, me);

module.exports = router;
