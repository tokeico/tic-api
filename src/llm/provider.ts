// The agent's LLM: a local model in Ollama, behind one small interface
// (ARCHITECTURE §1: one interface per external dependency). It runs on this
// machine, so invoices and bank details never leave it (DECISIONS D12).
//
// Env: LLM_MODEL (default llama3.1:8b), OLLAMA_URL (default http://localhost:11434),
// LLM_NUM_CTX (default 8192), LLM_TIMEOUT_MS (default 90000).

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string; name: string };

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
}

export interface LlmProvider {
  name: string;
  model: string;
  chat(system: string, messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatResult>;
  /** One-shot structured output: the reply must match `schema` (JSON Schema). */
  json(system: string, user: string, schema: Record<string, unknown>): Promise<unknown>;
  /** Ollama is running and the model is pulled. */
  available(): Promise<boolean>;
}

export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}

const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 90_000);

let seq = 0;
const callId = () => `call_${++seq}`;

/** Tool-call arguments may arrive as an object or a JSON string. */
function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const v = JSON.parse(raw);
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Small local models sometimes write the tool call as JSON in the text instead
 * of the tool-call field: {"name": "get_payout", "parameters": {...}}. Accept
 * that too, but only for tools we actually offered.
 */
export function toolCallsFromText(content: string, tools: ToolSpec[]): ToolCall[] {
  const names = new Set(tools.map((t) => t.name));
  const text = content.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  if (!text.startsWith("{") && !text.startsWith("[")) return [];
  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const calls: ToolCall[] = [];
    for (const c of list) {
      const name = c?.name ?? c?.function?.name;
      if (typeof name !== "string" || !names.has(name)) return [];
      calls.push({ id: callId(), name, args: parseArgs(c.parameters ?? c.arguments ?? c.function?.arguments) });
    }
    return calls;
  } catch {
    return [];
  }
}

async function call(base: string, model: string, body: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new LlmUnavailableError(`Can't reach Ollama at ${base}: ${(err as Error).message}. Is \`ollama serve\` running?`);
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    if (res.status === 404) throw new LlmUnavailableError(`Model ${model} isn't pulled. Run: ollama pull ${model}`);
    throw new LlmUnavailableError(`Ollama call failed (${res.status}): ${detail}`);
  }
  return res.json();
}

export function ollamaProvider(url = process.env.OLLAMA_URL ?? "http://localhost:11434", model = process.env.LLM_MODEL ?? "llama3.1:8b"): LlmProvider {
  const base = url.replace(/\/$/, "");
  return {
    name: "ollama",
    model,
    async available() {
      try {
        const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
        if (!res.ok) return false;
        const { models } = (await res.json()) as { models?: { name: string }[] };
        return (models ?? []).some((m) => m.name === model || m.name === `${model}:latest`);
      } catch {
        return false;
      }
    },
    async json(system, user, schema) {
      const out = (await call(base, model, {
        model,
        stream: false,
        format: schema,
        options: { temperature: 0, seed: 7, num_ctx: Number(process.env.LLM_NUM_CTX ?? 8192) },
        keep_alive: "30m",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      })) as { message?: { content?: string } };
      try {
        return JSON.parse(out.message?.content ?? "");
      } catch {
        throw new LlmUnavailableError("The model didn't return valid JSON.");
      }
    },
    async chat(system, messages, tools) {
      const body = {
        model,
        stream: false,
        // As deterministic as the model allows, and enough context for tool results.
        options: { temperature: 0, seed: 7, num_ctx: Number(process.env.LLM_NUM_CTX ?? 8192) },
        keep_alive: "30m",
        tools: tools.map((t) => ({ type: "function", function: t })),
        messages: [
          { role: "system", content: system },
          ...messages.map((m) => {
            if (m.role === "assistant") {
              return {
                role: "assistant",
                content: m.content,
                ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args } })) } : {}),
              };
            }
            if (m.role === "tool") return { role: "tool", content: m.content, tool_name: m.name };
            return { role: "user", content: m.content };
          }),
        ],
      };
      const out = (await call(base, model, body)) as { message?: { content?: string; tool_calls?: { function: { name: string; arguments: unknown } }[] } };
      const content = out.message?.content ?? "";
      const calls = (out.message?.tool_calls ?? []).map((c) => ({ id: callId(), name: c.function.name, args: parseArgs(c.function.arguments) }));
      return { content, toolCalls: calls.length ? calls : toolCallsFromText(content, tools) };
    },
  };
}

export const getProvider = (): LlmProvider => ollamaProvider();
