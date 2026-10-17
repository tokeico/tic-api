import { Hono } from "hono";
import { cors } from "hono/cors";
import { payoutRoutes } from "./routes/payouts";

const app = new Hono();

app.use(
  "*",
  cors({
    origin: process.env.WEB_ORIGIN ?? "http://localhost:8080",
  }),
);

app.get("/", (c) => {
  return c.text("Hello Hono!");
});

app.route("/api/payouts", payoutRoutes);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: { code: "internal", message: err.message } }, 500);
});

export { app };

export default {
  port: 3000,
  fetch: app.fetch,
};
