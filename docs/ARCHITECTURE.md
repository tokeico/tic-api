# Corredor: Technical Architecture

Companion to [PRD.md](./PRD.md). Built for today: simple, deterministic and demo-proof. Matches the existing repos **`tic-api`** (Bun + Hono + Drizzle + Postgres) and **`tic-web`** (TanStack Start + Tailwind).

---

## 1. Principles

1. **AI reads and explains, code decides, a human approves.** A **local Llama model** extracts invoices and writes memos. The allow/block decision is plain TypeScript over data. Money moves only after a human approves.
2. **Invoices never leave our infrastructure.** The LLM runs on our own machine through Ollama, with no third-party AI API. That's a real selling point to finance and compliance buyers.
3. **Rules are data.** Every rule has an effective date and a source URL. Changing the law means changing one row of JSON.
4. **Deterministic core.** The same inputs and the same as-of date always give the same plan, and `bun test` proves it.
5. **One interface per external dependency.** Rails, the sanctions list, FX and the LLM each sit behind an interface with a fallback, so the demo never depends on anything outside the laptop.
6. **Tamper-evident evidence.** Every step is appended to a keyed hash chain with signed checkpoints (§12).

## 2. System overview

```
┌──────────────── tic-web (TanStack Start · React 19 · Tailwind) ── :8080 ───────┐
│ Router (file routes) · Query (server state) · Form · Table                     │
│ Inbox · Payout detail · Ledger · Audit · As-of slider (URL search param)       │
└───────────────┬────────────────────────────────────────────────────────────────┘
                │ fetch JSON (CORS)   PUBLIC_API_URL
┌───────────────▼──────────────── tic-api (Bun · Hono) ── :3000 ──────────────────┐
│ routes/*  ──►  corredor/*  (pure TS core)                                      │
│                                                                                │
│  pdf→text ─► extract ─► screen ─► quote ─► RULES ENGINE(asOf) ─► memo ─► approve│
│  (unpdf)    (Llama)    (OFAC)   (registry) (pure TS + rules.json) (Llama) (policy)
│                                                               │                │
│                                 reconcile ◄── pay ◄───────────┘                │
│                                 (match+JE)    (RailAdapter: mock | sandbox)    │
│  audit.append() every step ─► HMAC-SHA-512 chain + Ed25519-signed checkpoints  │
└──────┬──────────────────────────────┬──────────────────────────────────────────┘
       │ Drizzle (bun-sql)            │ HTTP :11434
┌──────▼────────┐             ┌───────▼─────────────┐   ┌──────────────────────────┐
│ Postgres 17   │             │ Ollama · Llama 3.1 8B│   │ Bridge / BlindPay sandbox │
│ (Docker/managed)            │ (local, no cloud AI) │   │ (optional, else mock)     │
└───────────────┘             └─────────────────────┘   └──────────────────────────┘
```

## 3. Stack

| Layer | Choice | Notes |
|---|---|---|
| Web | **TanStack Start** (React 19) + **TanStack Router / Query / Form / Table**, Tailwind v4, Biome | Already in `tic-web`. Its bundler is **rsbuild**, not Vite (see §16). |
| API | **Hono** on **Bun** | Already in `tic-api`. Use `hono/cors` and `@hono/zod-validator`. |
| Validation and contracts | **zod v4** | Shared schemas. `z.toJSONSchema()` feeds the LLM's structured output. |
| DB | **Postgres 17 + Drizzle** (`drizzle-orm/bun-sql`) | Already in `tic-api`. Follow `DATABASE.md`: edit the schema, `db:generate`, `db:migrate`, commit `drizzle/`. |
| LLM | **Ollama** serving **Llama 3.1 8B Instruct** (`llama3.1:8b`); fallback `llama3.2:3b` | Native `/api/chat` with a JSON-schema `format` for structured output. Temperature 0 with a fixed seed. |
| PDF text | `unpdf` | Text layer from the PDF goes to the LLM, so no vision model is needed. Demo PDFs are generated with a text layer. |
| Crypto | `node:crypto` (works in Bun) | HMAC-SHA-512 and Ed25519 (§12) |
| Tests | `bun test` | Per `tic-api/CLAUDE.md`. Don't use vitest. |
| Hosting | **BitQate**: Docker containers, managed Postgres, Git-push deploys | §15 |

## 4. Repo layout

### `tic-api`
```
src/
├─ index.ts                 Hono app: cors, routes, error handler; export default { port: 3000, fetch: app.fetch }
├─ routes/                  payouts.ts · invoices.ts · plan.ts · ledger.ts · audit.ts · rules.ts · settings.ts
├─ contracts.ts             zod schemas + types shared with tic-web (§5) ← contract freeze 9:30
├─ corredor/
│  ├─ rules/rules.json      rules pack v1 (§6)
│  ├─ rules/checks.ts       pure check functions
│  ├─ rules/engine.ts       plan(invoice, routes, asOf) → Plan
│  ├─ quote.ts              candidate routes from offramps.json + fx.json
│  ├─ screen.ts             OFAC SDN fuzzy match
│  ├─ policy.ts             mandate: 2nd approver, daily cap
│  ├─ rails/{adapter,mock,bridge}.ts
│  ├─ reconcile.ts          match + journal entry
│  └─ audit.ts              HMAC chain + signed checkpoints + verify
├─ llm/
│  ├─ ollama.ts             chatJSON(schema, system, user)
│  ├─ pdf.ts                PDF → text (unpdf)
│  ├─ extract.ts            text → Invoice (+ sha256 cache in DB)
│  └─ memo.ts               Plan → Memo (cited-rule guard, template fallback)
├─ db/{index,schema,migrate}.ts   (existing; add tables §11)
data/   offramps.json · fx.json · sdn.csv · seed/invoices/*.pdf
scripts/ seed.ts · fixtures.ts (writes fixtures for tic-web) · keys.ts (generates audit keys)
test/   rules.test.ts · audit.test.ts
Dockerfile
```

### `tic-web`
```
src/
├─ routes/
│  ├─ __root.tsx            shell: nav, AsOf slider, badges, QueryClientProvider
│  ├─ index.tsx             Payouts inbox  (search: ?asOf=2026-10-17)
│  ├─ payouts.$id.tsx       Payout detail
│  ├─ ledger.tsx            Ledger
│  └─ audit.tsx             Audit
├─ lib/
│  ├─ contracts.ts          copied from tic-api/src/contracts.ts (do not edit here)
│  ├─ api.ts                queryOptions + mutations, USE_FIXTURES switch
│  └─ format.ts             Money, dates
├─ components/              StatusPill, Money, RouteChip, RuleRef, SimBadge, …
└─ fixtures/                JSON produced by tic-api scripts/fixtures.ts
```

## 5. Contracts (`tic-api/src/contracts.ts`, copied to `tic-web/src/lib/contracts.ts`)

```ts
import { z } from "zod";

export const Country = z.enum(["BR", "MX", "AR", "CO", "VE"]);
export const LocalRail = z.enum(["pix", "spei", "cvu", "pse", "swift"]);

export const Invoice = z.object({
  invoiceNumber: z.string(),
  payeeName: z.string(),
  payeeCountry: Country,
  payeeTaxId: z.string().nullable(),          // CNPJ / RFC / CUIT / RIF
  amount: z.number(),
  currency: z.string(),                       // BRL, MXN, USD, ...
  dueDate: z.string().nullable(),             // ISO date
  bankId: z.object({ type: LocalRail, value: z.string() }).nullable(),
  description: z.string(),
  purposeCode: z.string().nullable(),
  lowConfidence: z.array(z.string()),         // fields the model was unsure about
});
export type Invoice = z.infer<typeof Invoice>;

export type OfframpType =
  | "vasp_authorized" | "vasp_pending" | "vasp_unfiled" | "efx" | "bank"
  | "nonbank_licensed" | "psav_registered" | "p2p_unregistered";
// vasp_unfiled: operating in Brazil but hasn't filed for BCB authorization (deadline 2026-10-30)
// nonbank_licensed: legacy id; in MX it means a SAT-registered platform (Mexico has no crypto license)

export interface Offramp {
  id: string; name: string; country: z.infer<typeof Country>; type: OfframpType;
  feePct: number; assets: ("USDC" | "USDT")[]; networks: ("base" | "arbitrum" | "tron")[];
  rail: z.infer<typeof LocalRail>; minutes: number;
}

export interface Route {
  id: string; kind: "wire" | "stablecoin";
  asset: "USDC" | "USDT" | null; network: "base" | "arbitrum" | "tron" | null;
  offramp: Offramp | null; rail: z.infer<typeof LocalRail>;
  feePct: number; feeUsd: number; minutes: number; amountUsd: number;
}

export type Outcome = "pass" | "warn" | "block" | "require_fields";
export interface RuleResult {
  ruleId: string; title: string; outcome: Outcome; message: string;
  source: { name: string; url: string }; effectiveFrom: string | null; missingFields?: string[];
}
export interface RouteEvaluation { route: Route; results: RuleResult[]; compliant: boolean }

export type PayoutStatus =
  | "draft" | "needs_info" | "blocked" | "awaiting_second_approver" | "ready"
  | "approved" | "paid" | "booked";

export interface Plan {
  payoutId: string; asOf: string;
  screening: { status: "clear" | "possible_match" | "hit"; match?: string; score?: number };
  evaluations: RouteEvaluation[]; recommended: Route | null;
  status: PayoutStatus; reasons: string[];
}

export const Memo = z.object({
  summary: z.string(), routeRationale: z.string(), citedRuleIds: z.array(z.string()),
  warnings: z.array(z.string()), humanChecks: z.array(z.string()), vendorEmail: z.string().optional(),
});
export type Memo = z.infer<typeof Memo>;

// frontend-facing shapes: PayoutSummary, PayoutDetail, Reroute, JournalEntry, AuditEvent (FRONTEND §5)
```

## 6. Rules pack (`corredor/rules/rules.json`)

Each rule = **when** (corridor + effective window) + **check** (named function plus params) + **outcome** + **source**. The full JSON, with each rule's message and source, is in [`src/corredor/rules/rules.json`](../src/corredor/rules/rules.json). The legal sourcing, verdicts and contested points for every rule are in **[RULES-SOURCES.md](./RULES-SOURCES.md)**.

11 rules, verified against primary sources on 2026-10-17 (researcher plus an independent adversarial check). Dates are inclusive; `→` means open-ended.

| ID | Corridor | Effective | Check | Outcome | Source (primary) |
|---|---|---|---|---|---|
| BR-521-FX | BR | 2026-05-04 → | `requireFields(["purposeCode","payeeTaxId"])` | `require_fields` | Res. BCB 521 (Res. 277 arts. 76-A to 76-C; art. 6) |
| BR-521-CAP | BR | 2026-02-02 → | `amountUsdAbove(100000, ["vasp_authorized","vasp_pending","vasp_unfiled"])` | `block` | Res. BCB 521 (Res. 277 art. 29, IV) |
| BR-561-EFX | BR | 2026-10-01 → | `offrampTypeIn(["efx"])` | `block` | Res. BCB 561 (Res. 277 art. 50, I) |
| BR-VASP-PENDING-WARN | BR | 2026-02-02 → | `offrampTypeIn(["vasp_pending"])` | `warn` | Res. BCB 520 art. 88 I, §6; IN 704 art. 9; Res. 548 |
| BR-VASP-UNFILED-WARN | BR | 2026-02-02 → 2026-10-30 | `offrampTypeIn(["vasp_unfiled"])` | `warn` | Res. BCB 520 art. 88 I, §7; IN 704 art. 9 |
| BR-VASP-AUTH | BR | 2026-10-31 → | `offrampTypeIn(["vasp_unfiled"])` | `block` (Corredor policy) | Res. BCB 520 art. 88 §7; art. 91 per Res. 589 |
| BR-VASP-ART91 | BR | 2026-11-06 → | `offrampTypeIn(["vasp_pending"])` | `warn` | Res. BCB 589 (new art. 91 of Res. 520) |
| MX-BANK-CRYPTO | MX | 2019-03-09 → | `offrampTypeIn(["bank"])` | `block` | Banxico Circular 4/2019, rule 3.a (DOF 08-03-2019) |
| AR-PSAV | AR | 2024-03-25 → | `offrampTypeIn(["p2p_unregistered"])` | `block` | CNV RG 1172/2026 (Normas Tít. XIV Cap. III arts. 1, 3, 4) |
| AR-FX-SPREAD | AR | always | `fxSpreadAbove(5, "ARS")` | `warn` (business risk) | BCRA Com. A 3500 wholesale (API) vs. USDT/ARS snapshot |
| VE-OFAC | VE | always | `always()` | `block` (policy hold) | OFAC: 31 CFR 591; EO 13884; FAQ 680 |

`appliesTo` is `stablecoin` for every rule except AR-FX-SPREAD and VE-OFAC, which are `any` (they also apply to the wire).

Show the badge "Rules pack v1 · sourced · pending compliance review" in the UI. Verified is not the same as legally reviewed: the pack still needs a human compliance review before production.

**Check functions** (`checks.ts`): `always`, `offrampTypeIn(types)`, `amountUsdAbove(limit, offrampTypes?)`, `requireFields(fields)`, `fxSpreadAbove(pct, pair)`. Each is pure: `(ctx: { invoice, route, fx }, params) => { hit: boolean; missing?: string[]; detail?: string }`. Params are validated with zod when the pack loads, so a bad rule fails at startup.

## 7. Demo data

**`data/offramps.json`** (fictional providers, labeled demo):

| id | name | country | type | fee | asset/network | rail |
|---|---|---|---|---|---|---|
| br-pagafx | PagaFX | BR | `efx` | 0.55% | USDC/base | pix |
| br-ponte | Ponte Digital | BR | `vasp_unfiled` | 0.70% | USDC/base | pix |
| br-sol | Sol VASP | BR | `vasp_authorized` | 0.85% | USDC/base, arbitrum | pix |
| mx-puente | Puente MX | MX | `nonbank_licensed` | 0.60% | USDC/base | spei |
| mx-bancoazul | Banco Azul | MX | `bank` | 0.40% | USDC/base | spei |
| ar-pampa | Pampa PSAV | AR | `psav_registered` | 1.10% | USDT/tron | cvu |
| ar-cueva | Cueva P2P | AR | `p2p_unregistered` | 0.50% | USDT/tron | cvu |

The design means the cheapest option is always non-compliant somewhere:
- **BR:** before Oct 1, PagaFX (`efx`) wins. Oct 1–30, PagaFX is blocked by BR-561-EFX and Ponte wins with a BR-VASP-UNFILED-WARN warning: it's operating but hasn't filed for BCB authorization, and the filing deadline is Oct 30. From Oct 31, Ponte is blocked by BR-VASP-AUTH (missed the deadline) and only Sol passes. That gives **three distinct routes** on the slider. Oct 30 is deliberately *not* a reroute date, because it's still a valid filing day ([RULES-SOURCES.md](./RULES-SOURCES.md) §6). Sol being "authorized" is hypothetical: no SPSAV had been authorized as of mid-October 2026.
- **MX:** Banco Azul is always blocked, so Puente is chosen. Puente's type id is `nonbank_licensed`, but describe it as a **SAT-registered** virtual-asset platform: Mexico has no crypto license.
- **AR:** Cueva is blocked, so Pampa is chosen.

No demo provider is `vasp_pending`, so BR-VASP-PENDING-WARN and BR-VASP-ART91 never fire on the slider. They cover real-world providers that filed on time.

**`data/fx.json`** (demo rates, labeled): `{ "BRL": 5.40, "MXN": 18.50, "ARS_official": 1518, "ARS_parallel": 1619 }`. The ARS pair is a snapshot from 2026-10-16: `ARS_official` is the BCRA Com. A 3500 wholesale rate and `ARS_parallel` is the USDT/ARS (crypto) rate. That's a 6.7% gap, so AR-FX-SPREAD fires at its 5% threshold. The wire route is always `{ feePct: 4.5, minutes: 2880 }`.

## 8. Local LLM (Ollama + Llama)

| Step | Code | LLM? | Output |
|---|---|---|---|
| PDF → text | `llm/pdf.ts` (unpdf) | No | plain text |
| Extract | `llm/extract.ts` | **Llama**, JSON-schema constrained | `Invoice` |
| Screen · Quote · Plan | `corredor/*` | **No (deterministic)** | `Plan` |
| Memo | `llm/memo.ts` | **Llama**, JSON-schema constrained | `Memo` |
| Vendor email (P1) | `llm/memo.ts` | Llama, when status = `needs_info` | text |

**Client** (`llm/ollama.ts`):

```ts
import { z } from "zod";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const LLM_MODEL = process.env.LLM_MODEL ?? "llama3.1:8b";

export async function chatJSON<T extends z.ZodType>(schema: T, system: string, user: string): Promise<z.infer<T>> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: LLM_MODEL,
      stream: false,
      format: z.toJSONSchema(schema),          // structured output: model must emit this shape
      options: { temperature: 0, seed: 7 },    // repeatable output
      keep_alive: "30m",                       // keep the model warm for the demo
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const data = (await res.json()) as { message: { content: string } };
  return schema.parse(JSON.parse(data.message.content));   // validate; throw → caller falls back
}
```

**Making an 8B model reliable:**
- **Deterministic pre-pass:** regexes pull CLABE (18 digits), CNPJ (14 digits), CVU (22 digits) and Pix keys from the text before the LLM runs. Checksums validate them, and validated values override the model's output.
- **Structured output:** Ollama's JSON-schema `format` plus `schema.parse` on the result. On a validation failure, retry once, then mark the fields `lowConfidence` for a human to fix.
- **Cache:** extraction results keyed by the PDF's sha256 (table `extraction_cache`). The four demo invoices are pre-warmed.
- **Memo guard:** reject any `citedRuleIds` entry that isn't in the Plan and retry once. If the model is down or slow, use a **template memo** built from the rule messages. The decision path never depends on the LLM.

**Setup:** `ollama pull llama3.1:8b` (about 5 GB; fine on an Apple Silicon laptop). If it's slow on the demo machine, set `LLM_MODEL=llama3.2:3b`.

## 9. API (Hono, `tic-api/src/routes`)

`app.use("*", cors({ origin: process.env.WEB_ORIGIN ?? "http://localhost:8080" }))`. Request bodies are validated with zod (`safeParse`, no extra dependency). Errors come back as `{ error: { code, message } }`.

| Method | Route | Does |
|---|---|---|
| GET | `/api/payouts` · `/api/payouts?detail=1` · `/api/payouts/:id` | `PayoutSummary[]` · `PayoutDetail[]` (one request for the whole UI) · `PayoutDetail` (with a template memo and a plan `fingerprint`) |
| GET | `/api/payouts/:id/preview?asOf=&registry=id:type` | dry run: the plan on another date, optionally with a hypothetical registry update. Stores nothing |
| GET | `/api/payouts/:id/replay?n=100` | recompute the plan n times → `{ identical, matchesStored, fingerprint, ms }` (determinism proof) |
| POST | `/api/invoices` | multipart PDF (`file`) → text → injection scan → checksum pre-pass + local model → invoice + payout (+ security hold if flagged) → plan. `409` duplicate, `422` no text layer, `503` model down (cache hits still work). See docs/AGENT.md |
| POST | `/api/payouts/:id/memo` | the local model writes the memo for the current plan; citation and decision guards, else the template stays |
| POST/GET | `/api/agent/chat` · `/api/agent/status` | the Agent tab's local model (read-only tools + proposals) |
| PATCH | `/api/payouts/:id` | edit invoice fields → re-plan. A failed checksum puts the field back in `lowConfidence`. Approved payouts are frozen (409 `plan_locked`) |
| POST | `/api/payouts/:id/plan?asOf=` | screen + quote + rules → `Plan`, then memo |
| POST | `/api/plan-all?asOf=` | re-plan all open payouts → `{ payouts, reroutes }` (the slider calls this) |
| POST | `/api/payouts/:id/screening-review` | `{ reviewer, decision, note }`: a person clears or confirms a sanctions match (controller / approver only) |
| POST | `/api/payouts/:id/sanctions-review` | `{ reviewer, decision, licenseRef?, note }`: a compliance person releases the VE-OFAC policy hold (or confirms it). A release turns the block into a warning naming the sign-off; it covers the payee and bank details as reviewed, so editing either re-arms the hold |
| POST | `/api/payouts/:id/security-review` | `{ reviewer, decision, note }`: a person clears the security hold (instruction-like text) or keeps the payout held as suspicious. Approvals are refused while it is uncleared; rejections stay possible |
| POST | `/api/payouts/:id/approve` | `{ approver, decision?, comment? }`; `approver` is a user id, name or email; second approval if over the cap |
| POST | `/api/payouts/:id/pay` | `RailAdapter.send(recommended)`; optional `{ by }` names the person in the audit log |
| POST | `/api/payouts/:id/reconcile` | match → journal entry; optional `{ by }` |
| GET | `/api/ledger` · `/api/ledger.csv` | journal entries · CSV export |
| GET | `/api/audit` · `/api/audit/verify?tamper=` | events · chain and signature check (`tamper=<seq>` edits that event in memory only, for the demo) |
| GET | `/api/rules?asOf=` · `/api/rules?all=1` | active rules · the whole pack |
| GET | `/api/offramps` | provider registry with approved registry updates and each provider's on/off switch |
| GET/PUT | `/api/settings` | `{ asOf, railMode, policy, objective, disabledOfframps, registry }`. PUT takes any subset plus `by`, audits each change (`settings_changed`), re-plans open payouts and returns the reroutes |
| POST | `/api/demo/reset` | wipe back to the four draft demo invoices (local DBs only; `ALLOW_DEMO_RESET=0` disables it) |
| GET | `/api/health` | DB, Ollama and model status (for the demo checklist) |

## 10. Rules engine (`corredor/rules/engine.ts`)

```
plan(invoice, asOf):
  routes   = quote(invoice)                          // wire + every stablecoin route for the corridor
  screening = screen(invoice.payeeName)
  for each route:
     results = rules.filter(r => r.corridor == country && active(r, asOf) && applies(r, route))
                    .map(r => evaluate(r.check, ctx))
     compliant = no result is "block"
  recommended = cheapest compliant stablecoin route, else the wire if compliant, else null
  status = screening hit/possible → "blocked"
         | recommended == null    → "blocked"
         | missing required fields → "needs_info"
         | amountUsd > policy.secondApproverAboveUsd → "awaiting_second_approver"
         | otherwise → "ready"
```
Pure function with no I/O. Rules, off-ramps and FX are loaded once at startup.

## 11. Data model (Drizzle, `src/db/schema.ts`)

Keep the example `users` table or remove it in the same migration. Then `bun run db:generate && bun run db:migrate` and commit `drizzle/`.

```ts
payouts          (id text pk, invoice jsonb, status text, as_of date, plan jsonb, memo jsonb, created_at timestamptz)
approvals        (id serial pk, payout_id text fk, approver text, created_at timestamptz)
payments         (id serial pk, payout_id text fk, route jsonb, tx_hash text, offramp_ref text, rail_ref text,
                  rail_mode text, status text, created_at timestamptz)
journal_entries  (id serial pk, payout_id text fk, lines jsonb, booking_rate numeric, settle_rate numeric, created_at timestamptz)
audit_events     (seq bigserial pk, payout_id text, type text, payload jsonb, created_at timestamptz,
                  prev_mac text, mac text, key_id text)
audit_checkpoints(seq bigint pk, head_mac text, signature text, public_key_id text, created_at timestamptz)
extraction_cache (pdf_sha256 text pk, invoice jsonb, model text, created_at timestamptz)
settings         (key text pk, value jsonb)          -- demo_as_of, policy, rail_mode
```

**Policy:** `{ "secondApproverAboveUsd": 50000, "dailyCapUsd": 150000 }`

## 12. Audit trail: keyed hash chain plus signatures

A plain SHA-256 chain isn't broken cryptographically. Its weakness is that **anyone with database write access can rewrite a row and recompute every hash after it**. So we make the chain keyed and signed:

1. **HMAC-SHA-512 chain.** `mac_n = HMAC-SHA-512(AUDIT_HMAC_KEY, mac_{n-1} ‖ canonicalJSON(event_n))`. The 256-bit key lives only in the API's secrets, never in the DB. Without the key, nobody can produce a valid chain, even with full DB access.
2. **Ed25519-signed checkpoints.** Every 10 events, and after each payout reaches `booked`, the API signs the head MAC with `AUDIT_SIGNING_KEY` (Ed25519) and stores it in `audit_checkpoints`. Anyone holding the **public key** can verify the checkpoints without any secret, which is what an auditor needs.
3. **Canonical JSON:** sorted keys and no whitespace, so the same event always produces the same bytes.
4. **`verify()`** recomputes every MAC and checks every checkpoint signature. It reports `{ ok, count, brokenAt?, lastSignedSeq }`. The UI shows "Chain verified · signed".
5. **Key IDs** on each row allow rotation later.

```ts
import { createHmac, sign, verify } from "node:crypto";   // supported in Bun
const mac = createHmac("sha512", HMAC_KEY).update(prevMac).update(canonical(event)).digest("hex");
const sig = sign(null, Buffer.from(headMac, "hex"), SIGNING_PRIVATE_KEY);      // Ed25519
const ok  = verify(null, Buffer.from(headMac, "hex"), SIGNING_PUBLIC_KEY, sig);
```

`scripts/keys.ts` generates both keys once. Keys go into `.env` locally and into BitQate secrets in deployment. **Test:** tampering with any row, or with a checkpoint, makes `verify()` fail (`test/audit.test.ts`).

> Pitch line: "Even our own database admin can't quietly rewrite the history. Auditors verify it with a public key."

## 13. Rails and reconciliation

```ts
export interface RailAdapter {
  mode: "mock" | "bridge" | "blindpay";
  send(p: { payoutId: string; route: Route; amountUsd: number; payee: Invoice }):
    Promise<{ txHash: string; offrampRef: string; railRef: string; settledLocal: number; settleRate: number }>;
}
```
- `mock.ts` derives IDs deterministically from `payoutId`, applies a small simulated rate move so the FX line isn't zero, and the UI always shows the `rail_mode` badge.
- **Reconciliation:** a payment is `matched` when invoice ↔ payment ↔ rail reference link 1:1 and amounts agree within the quoted fee. Otherwise it's an `exception` with a reason.
- **Journal entry (example, BR):** debit AP – Estúdio Paulista 15,740.74 (R$85,000 at 5.40) · debit fees 133.80 · credit Cash – USDC (Base) 15,874.54 · FX gain/loss from the booking-vs-settle rate difference.

## 14. Testing (`bun test`)

- `test/rules.test.ts`: golden tests for the four demo invoices at `2026-09-30`, `2026-10-01`, `2026-10-17` and `2026-10-31` (`DEMO_DATES` in `src/corredor/demo.ts`):
  - BR goes PagaFX → Ponte → Ponte → Sol; Ponte carries the BR-VASP-UNFILED-WARN warning on Oct 1 and Oct 17
  - Oct 30 changes nothing for BR (still a valid filing day); Oct 17 → Oct 31 reroutes to Sol and names BR-VASP-AUTH
  - MX is always Puente, `awaiting_second_approver`
  - AR is Pampa with an `AR-FX-SPREAD` warning (1,518 vs. 1,619, 6.7%)
  - VE is `blocked`
  - The pack has exactly the 11 rules, each with an `https://` source; BR-VASP-ART91 is active from 2026-11-06
  - **Determinism:** run `plan()` 100 times and get byte-identical JSON.
- `test/audit.test.ts`: the chain verifies; editing one payload breaks it at that sequence number; a forged checkpoint signature fails.
- `test/extract.test.ts` (optional, needs Ollama): the four demo PDFs extract to the expected fields.

## 15. Hosting on BitQate

BitQate runs Docker images or Git repos (rebuilt on each push), managed PostgreSQL, and full-root KVM VPSs.

| Service | BitQate resource | Notes |
|---|---|---|
| `tic-api` | Docker container from a Git repo | `Dockerfile` based on `oven/bun`: `bun install --frozen-lockfile` → `bun run db:migrate` (release step) → `bun run src/index.ts` |
| Postgres | **Managed PostgreSQL** | Set `DATABASE_URL` (add `?sslmode=require` if needed). Never `db:push` against it. |
| `tic-web` | Docker container from a Git repo | `bun --bun run build` → `bun run start` (srvx). Set `PUBLIC_API_URL` to the API's URL. |
| Ollama | **KVM VPS** (or a container) running `ollama serve` | CPU-only is slow, so host `llama3.2:3b` there. **For the live demo, run Ollama on the presenting laptop** and point `OLLAMA_URL` at it. |

**Demo setup we recommend:** the public link (judges can click it) runs on BitQate with cached extractions and template-memo fallback. The live pitch runs the API and Ollama on the laptop for speed. Check `GET /api/health` before going on stage.

**Secrets:** `DATABASE_URL`, `AUDIT_HMAC_KEY`, `AUDIT_SIGNING_KEY`, `AUDIT_PUBLIC_KEY`, `OLLAMA_URL`, `LLM_MODEL`, `RAIL_MODE`, `WEB_ORIGIN`, plus `BRIDGE_API_KEY` if the sandbox is approved.

## 16. Notes and decisions

- **Bundler:** `tic-web` was scaffolded with **rsbuild**, not Vite (`rsbuild.config.ts`). Both work with TanStack Start. Keep rsbuild unless someone has a reason to switch. Moving to Vite means replacing `rsbuild.config.ts` with `vite.config.ts` using the `tanstackStart()` Vite plugin and renaming env vars from `PUBLIC_` to `VITE_`.
- **Ports:** web on **8080** (dev script), API on **3000** (Hono/Bun default). `rsbuild.config.ts` also says 3000, but the `--port 8080` flag wins. Delete that line to avoid confusion.
- **Contracts sync:** `tic-api/src/contracts.ts` is the source of truth. Copy it into `tic-web/src/lib/contracts.ts` whenever it changes, and post in the team chat when you do.
- **Archie** is out of the stack, which means **we don't compete for the separate Archie prize** ($2.5k / $1k / $500).

## 17. Demo-day runbook

- `ollama pull llama3.1:8b`, then `ollama run llama3.1:8b "hi"` to warm it up.
- `bun run db:reset && bun run scripts/seed.ts`, then pre-warm extraction for the four PDFs.
- `GET /api/health` should report DB ok, Ollama ok and model loaded.
- Leave the slider on **2026-10-17**. Rehearsed moves: **Sep 30 → Oct 1 → Oct 31 → today**.
- Re-check the OFAC Venezuela program page for new general licenses right before going on stage.
- **If the LLM is down:** cached extraction and the template memo still give every decision.
- **If the network is down:** the backup video plays from the laptop.

## Sources

- **Rules (all 11):** primary sources, verdicts and contested points are in [RULES-SOURCES.md](./RULES-SOURCES.md). Main texts:
  - Brazil: Res. BCB 521 https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo?tipo=Resolu%C3%A7%C3%A3o%20BCB&numero=521 · Res. BCB 561 https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo?tipo=Resolu%C3%A7%C3%A3o%20BCB&numero=561 · Res. BCB 520 https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo?tipo=Resolu%C3%A7%C3%A3o%20BCB&numero=520 · Res. BCB 589 https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo?tipo=Resolu%C3%A7%C3%A3o%20BCB&numero=589 · IN BCB 704 https://www.bcb.gov.br/estabilidadefinanceira/exibenormativo?tipo=Instru%C3%A7%C3%A3o%20Normativa%20BCB&numero=704
  - Mexico: Banxico Circular 4/2019 (DOF) https://dof.gob.mx/nota_detalle.php?codigo=5552303&fecha=08/03/2019
  - Argentina: CNV RG 1172/2026 (Boletín Oficial) https://www.boletinoficial.gob.ar/detalleAviso/primera/348986/20261015 · BCRA A 3500 rate API https://api.bcra.gob.ar/estadisticascambiarias/v1.0/Cotizaciones/USD
  - Venezuela: OFAC program page https://ofac.treasury.gov/sanctions-programs-and-country-information/venezuela-related-sanctions · OFAC FAQ 680 https://ofac.treasury.gov/faqs/680
- The secondary sources the v1 pack cited (fcm.law, Eco, Stablecoin Insider, iProUP) were replaced. Several were stale or didn't support the claim; see RULES-SOURCES.md.
- Costs and pain: https://stabled.co/resources/latam-report · https://eco.com/support/en/articles/14466065-stablecoin-settlement-reconciliation-in-2026-why-the-accounting-layer-is-the-real-bottleneck
- Rails: https://docs.stripe.com/stablecoins/ecosystem/bridge · https://blindpay.com/resources/more/best-stablecoin-apis-cross-border-payments-2026
- BitQate: https://www.producthunt.com/products/bitqate
