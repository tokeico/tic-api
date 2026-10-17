import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ApiError } from "./http-error";
import { payoutRoutes, planAllRoute } from "./routes/payouts";
import { referenceRoutes } from "./routes/reference";
import { agentRoutes } from "./routes/agent";
import { demoRoutes } from "./routes/demo";
import { invoiceRoutes } from "./routes/invoices";
import { ledgerRoutes } from "./routes/ledger";
import { demoPresentation } from "./presentation";
import { authRoutes } from "./routes/auth";
import { requireWorkspace } from "./security/middleware";
import { WEB_ORIGIN } from "./security/auth";
import { handleMcp } from "./mcp";

const app = new Hono();

app.use("/api/*", async (c, next) => {
  await next();
  if ((process.env.RAIL_MODE ?? "mock") !== "mock" || !c.res.headers.get("content-type")?.includes("application/json")) return;
  const data = await c.res.clone().json();
  const headers = new Headers(c.res.headers);
  headers.delete("content-length");
  c.res = new Response(JSON.stringify(demoPresentation(data)), { status: c.res.status, headers });
});

app.use(
  "*",
  cors({
    origin: WEB_ORIGIN,
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization", "MCP-Protocol-Version", "Mcp-Session-Id"],
    exposeHeaders: ["MCP-Protocol-Version", "Mcp-Session-Id"],
  }),
);

app.use("/api/auth/*", bodyLimit({ maxSize: 16 * 1024 }));
app.use("/api/*", bodyLimit({ maxSize: 12 * 1024 * 1024 }));
app.use("/api/*", requireWorkspace);
app.use("/mcp", bodyLimit({ maxSize: 64 * 1024 }));
app.use("/mcp", requireWorkspace);
app.all("/mcp", (c) => handleMcp(c.req.raw));

app.get("/", (c) => {
  return c.text("Hello Hono!");
});

app.route("/api/payouts", payoutRoutes);
app.route("/api/auth", authRoutes);
app.route("/api/plan-all", planAllRoute);
app.route("/api", referenceRoutes);
app.route("/api", ledgerRoutes);
app.route("/api/demo", demoRoutes);
app.route("/api/agent", agentRoutes);
app.route("/api/invoices", invoiceRoutes);

app.notFound((c) => c.json({ error: { code: "not_found", message: `No route for ${c.req.method} ${c.req.path}` } }, 404));

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status as ContentfulStatusCode);
  }
  console.error("Request failed", { name: err.name });
  return c.json({ error: { code: "internal", message: "The server could not complete this request." } }, 500);
});

export { app };

export default {
  port: 3000,
  fetch: (request: Request, server?: { requestIP: (request: Request) => { address: string } | null }) =>
    app.fetch(request, { peerIP: server?.requestIP(request)?.address }),
};
