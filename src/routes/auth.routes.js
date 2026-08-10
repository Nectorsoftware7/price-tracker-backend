const express = require("express");
const { login, me } = require("../controllers/auth.controller");
const { validateLogin } = require("../validators/auth.validator");
const requireAuth = require("../middlewares/auth.middleware");

const router = express.Router();

router.post("/login", validateLogin, login);
router.get("/me", requireAuth, me);

module.exports = router;
