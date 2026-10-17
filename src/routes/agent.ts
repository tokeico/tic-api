// POST /api/agent/chat   { messages, asOf? } → AgentReply (local model, read-only tools + proposals)
// GET  /api/agent/status → whether Ollama is up and the model is pulled

import { Hono } from "hono";
import { AgentChatRequest } from "../contracts";
import { ApiError } from "../http-error";
import { askAgent } from "../llm/agent";
import { LlmUnavailableError, getProvider } from "../llm/provider";

export const agentRoutes = new Hono();

agentRoutes.get("/status", async (c) => {
  const p = getProvider();
  return c.json({ available: await p.available(), model: p.model, provider: p.name });
});

agentRoutes.post("/chat", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON.");
  }
  const parsed = AgentChatRequest.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, "invalid_body", parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  if (parsed.data.messages.at(-1)?.role !== "user") throw new ApiError(400, "invalid_body", "The last message must be the user's.");
  try {
    return c.json(await askAgent({ turns: parsed.data.messages, asOf: parsed.data.asOf }));
  } catch (err) {
    if (err instanceof LlmUnavailableError) throw new ApiError(503, "llm_unavailable", err.message);
    throw err;
  }
});
