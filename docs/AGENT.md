# The Corredor agent (local LLM)

The Agent tab's chat is answered by a **local model in Ollama**. Nothing leaves the machine (DECISIONS D12). If the model is unreachable, the web app falls back to scripted replies over the same live data, so the demo never breaks.

**Principle:** AI reads and explains, code decides, a person approves. The model can look things up and *propose* actions. It cannot approve, pay, reconcile or change a rule, because no tool for that exists.

## Setup

```sh
ollama pull llama3.1:8b          # once, about 4.9 GB (fits an 8 GB GPU)
ollama serve                     # usually already running as a service
curl localhost:3000/api/agent/status   # {"available":true,"model":"llama3.1:8b","provider":"ollama"}
```

`.env` (tic-api):

| Variable | Default | What |
|---|---|---|
| `LLM_MODEL` | `llama3.1:8b` | Any Ollama model with tool calling (try `qwen2.5:7b` for better multi-step tool use) |
| `OLLAMA_URL` | `http://localhost:11434` | Where Ollama runs (a VPS for the hosted demo) |
| `LLM_NUM_CTX` | `8192` | Context window passed to Ollama |
| `LLM_TIMEOUT_MS` | `90000` | Per model call |

Restart the API after changing them. `/api/health` reports `llm: true` once the model is pulled.

## How it works

```
Agent tab ──POST /api/agent/chat { messages, asOf }──▶ src/llm/agent.ts askAgent()
                                                        │  loop, up to 6 rounds:
                                                        │   provider.chat(system, messages, TOOLS)
                                                        │   → tool calls → runTool() → results back
                                                        ▼
                                     AgentReply { text, tools, cites, removedCites, actions, model, ms }
```

| File | What |
|---|---|
| `src/llm/provider.ts` | Ollama adapter (native `/api/chat`, temperature 0, fixed seed). Also accepts tool calls written as JSON text, which small models sometimes do |
| `src/llm/agent.ts` | System prompt, tools, loop, guardrails |
| `src/routes/agent.ts` | `POST /api/agent/chat`, `GET /api/agent/status` (503 `llm_unavailable` when Ollama/model is missing) |
| `tic-web/src/lib/agent.ts` | Calls the API, turns the reply into chat bubbles and queue cards; scripted fallback (`respond()`) |

### Tools (all read-only except proposals)

| Tool | Returns |
|---|---|
| `list_payouts` | count + each payout: formatted amount, plain-language status, route, warnings, block reason |
| `get_payout(payout)` | invoice fields (identifiers masked), every route and what blocks it, rules checked with titles and outcomes, memo, approvals |
| `preview_plan(payout, as_of)` | dry run on another date (stores nothing) |
| `list_rules(all?)` | rules in force on the as-of date, or the whole pack |
| `get_policy` | approval policy, routing preference, provider switches, registry updates |
| `propose_action(kind, payout, title, why, ...)` | queues a card for a person: `approve`, `pay`, `reconcile`, `email`, `asof` |

`payout` accepts a payee name (accents optional), country code, invoice number or id.

### Guardrails (enforced in code, not only in the prompt)

- **No acting tools.** Proposals only; a person confirms each card in the queue (they run through the normal API with all its checks).
- **Proposals are validated** against the payout's real status (no `pay` for an unapproved payout); errors go back to the model so it can correct itself.
- **Masking:** bank and tax identifiers reach the model only as "ending 1234"; any 8+ digit run in the answer or an email draft is masked again (dates are left alone).
- **Citation guard:** rule ids in the answer must exist in the pack. Made-up ones are marked `[not in the rules pack]` and listed in `removedCites`.
- **Autonomy** (Customize tab, browser session): *Suggest only* drops proposals, *Prepare* queues them, *Auto-run low-risk* applies only `asof` (moving the demo clock) by itself.

## For coding agents working on this

- Add a tool: append to `TOOLS` and handle it in `runTool()` in `src/llm/agent.ts`. Keep it read-only, return compact JSON, mask identifiers with `maskId()`, and truncate long legal text with `short()`. Anything that changes state must go through `propose_action` instead.
- Keep tool output model-friendly: pre-formatted amounts (`USD 64,864.86`), status as text, explicit counts. An 8B model copies these reliably but makes mistakes when it has to compute or format them.
- Don't add a hosted LLM provider: the local-only rule is a product decision (D12).
- Tests: `test/payouts.test.ts` drives `askAgent()` with a **fake provider** (no Ollama needed) to check the loop, masking, proposal validation and the citation guard, and checks the 503 path. Run `bun test`. To try the real model: `curl -X POST localhost:3000/api/agent/chat -H 'content-type: application/json' -d '{"messages":[{"role":"user","content":"What needs my attention today?"}]}'`.
- Contracts (`AgentChatRequest`, `AgentReply`, `AgentProposal`, `AgentStatus`) live in `src/contracts.ts`; copy it to `tic-web/src/lib/contracts.ts` after changes.

## Known limits (llama3.1:8b)

- Answers take 3 to 8 s on an RTX-class GPU (much slower on CPU).
- It sometimes skips multi-step tool chains: for example it lists payouts but doesn't call `propose_action` for each one, or answers "what changes on Oct 31?" from the rules list instead of `preview_plan`. A stronger tool-calling model (`qwen2.5:7b`, `qwen3:8b`) via `LLM_MODEL` helps; the scripted fallback covers the demo questions deterministically.
