const ApiError = require("../utils/ApiError");

function validateLogin(req, res, next) {
  const { username, password } = req.body;
  if (!username || !password) return next(new ApiError(400, "username and password are required"));
  next();
}

module.exports = { validateLogin };
