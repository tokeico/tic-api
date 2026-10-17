import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ApiError } from "./http-error";
import { payoutRoutes, planAllRoute } from "./routes/payouts";
import { referenceRoutes } from "./routes/reference";
import { demoRoutes } from "./routes/demo";
import { ledgerRoutes } from "./routes/ledger";

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
app.route("/api/plan-all", planAllRoute);
app.route("/api", referenceRoutes);
app.route("/api", ledgerRoutes);
app.route("/api/demo", demoRoutes);

app.notFound((c) => c.json({ error: { code: "not_found", message: `No route for ${c.req.method} ${c.req.path}` } }, 404));

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status as ContentfulStatusCode);
  }
  console.error(err);
  return c.json({ error: { code: "internal", message: err.message } }, 500);
});

export { app };

export default {
  port: 3000,
  fetch: app.fetch,
};
