const express = require("express");
const cors = require("cors");

const authRouter = require("./routes/auth.routes");
const productsRouter = require("./routes/products.routes");
const reviewsRouter = require("./routes/reviews.routes");
const contactFormRouter = require("./routes/contactForm.routes");
const errorMiddleware = require("./middlewares/error.middleware");

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/auth", authRouter);
app.use("/api/products", productsRouter);
app.use("/api/reviews", reviewsRouter);
app.use("/api/contact-form", contactFormRouter);
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.use(errorMiddleware);

module.exports = app;
