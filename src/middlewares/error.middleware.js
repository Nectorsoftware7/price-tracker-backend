const ApiError = require("../utils/ApiError");

// eslint-disable-next-line no-unused-vars
function errorMiddleware(err, req, res, next) {
  if (err.code === "ER_DUP_ENTRY") {
    return res.status(400).json({ error: "This record already exists." });
  }
  const statusCode = err instanceof ApiError ? err.statusCode : err.statusCode || 500;
  if (statusCode >= 500) console.error(err);
  res.status(statusCode).json({ error: err.message || "Internal server error" });
}

module.exports = errorMiddleware;
