import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { currentPrincipal, withWorkspace } from "../db";
import { ApiError } from "../http-error";
import { principalFor, rateLimit, SESSION_COOKIE, WEB_ORIGIN } from "./auth";

export function assertBrowserOrigin(origin: string | undefined) {
  if (origin !== WEB_ORIGIN) throw new ApiError(403, "invalid_origin", "This request must originate from the Corredor application.");
}

export const requireWorkspace: MiddlewareHandler = async (c, next) => {
  if (c.req.method === "OPTIONS") return next();
  const path = c.req.path;
  if (path === "/api/health") return next();
  if (["/api/auth/signup", "/api/auth/signin"].includes(path)) {
    if (c.req.method !== "POST") throw new ApiError(404, "not_found", "Not found.");
    assertBrowserOrigin(c.req.header("origin"));
    const peer = (c.env as { peerIP?: string } | undefined)?.peerIP ?? "direct";
    await rateLimit(`${path}:${peer}`, path.endsWith("signup") ? 20 : 60, 60_000);
    return next();
  }
  const authorization = c.req.header("authorization");
  const bearer = authorization?.match(/^Bearer (ck_[A-Za-z0-9_-]{43})$/)?.[1];
  const token = authorization ? bearer : getCookie(c, SESSION_COOKIE);
  const principal = token ? await principalFor(token, authorization ? "apiKey" : "session") : null;
  if (!principal) {
    c.header("WWW-Authenticate", 'Bearer realm="corredor"');
    throw new ApiError(401, "unauthorized", "Sign in or provide a valid API key.");
  }
  const readOnlyPost = path === "/mcp" || path === "/api/agent/chat";
  if (!["GET", "HEAD"].includes(c.req.method)) {
    if (principal.credential === "session") assertBrowserOrigin(c.req.header("origin"));
    if (principal.credential === "apiKey" && !readOnlyPost) throw new ApiError(403, "read_only_api_key", "API keys can read data and use the read-only MCP tools, but cannot change state.");
    if (principal.role === "auditor" && !readOnlyPost && !path.startsWith("/api/auth/")) throw new ApiError(403, "not_authorized", "Your workspace role is read-only.");
  }
  await rateLimit(`account:${principal.accountId}`, 300, 60_000);
  if (path === "/api/agent/chat" || path === "/api/invoices") await rateLimit(`model:${principal.accountId}`, 6, 60_000);
  return withWorkspace(principal, next);
};

export function requirePrincipal() {
  const p = currentPrincipal();
  if (!p) throw new ApiError(401, "unauthorized", "Sign in to continue.");
  return p;
}
