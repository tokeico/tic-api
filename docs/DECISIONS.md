# Corredor: Decision Log

Decisions made on Oct 17, 2026 (eMerge AI Hackathon, Enterprise AI track). Each entry says what we decided, why, and what it means for the build. Details are in [PRD.md](./PRD.md), [ARCHITECTURE.md](./ARCHITECTURE.md) and [FRONTEND.md](./FRONTEND.md).

Status key: **Decided** · **Open** (needs a call) · **Superseded**

---

## Product

### D1. Build Corredor, a compliance-first payout agent for LatAm stablecoin payments. **Decided**
- **What:** An AP agent that reads an invoice, checks the payee against sanctions lists, compares routes, checks each country's rules as of a date, writes a cited memo, gets human approval, pays, and books the journal entry.
- **Why:** Rails and stablecoin AP already exist (Bitso Business, Bridge, BlindPay, Ramp, Request Finance, Bitwave). Nobody we found offers a compliance layer across rails with rules as versioned data and automatic rerouting when a rule takes effect. Miami is a strong place to pitch a LatAm corridor product.
- **Alternatives considered:** Agent Passport (Know-Your-Agent gateway). It's a more crowded space (Payman, Skyfire, Google AP2, Meow). Its mandate and approval ideas are folded into Corredor as policy (D6).

### D2. Positioning: "the compliance brain across every rail". **Decided**
- Don't lead with "pay LatAm in stablecoins". Ramp, Request Finance and Bitso already do that.
- Lead with: each country's rules as data, a cited memo per payout, automatic reroute when a rule changes, and books that close themselves.
- Prepared answer to "isn't compliance the provider's job?": each provider covers its own license. The paying company still owns its sanctions exposure, data accuracy, vendor KYB, audit trail and choice of rail.

### D3. Design principle: AI reads and explains, code decides, a human approves. **Decided**
- The LLM only extracts invoice data and writes explanations. Allow and block decisions come from deterministic TypeScript over `rules.json`. Money moves only after human approval.
- **Why:** CFOs on Reddit say they distrust AI touching the books ("probabilistic, not deterministic"). This scores on Technical Execution and on AI trust and governance.

### D4. Scope: Brazil, Mexico, Argentina and Venezuela, with Colombia as a stretch. **Decided**
- Each corridor demonstrates something different: BR shows rule changes over time (Res. 521 / 561, the Oct 30 VASP filing deadline), MX the bank ban, AR the PSAV registry and FX spread, VE a sanctions-review hold.

### D5. Rules pack: 11 rules, each with an effective date and a primary source. **Decided** (updated Oct 17: was 9 rules)
- BR-521-FX · BR-521-CAP · BR-561-EFX · BR-VASP-PENDING-WARN · BR-VASP-UNFILED-WARN · BR-VASP-AUTH · BR-VASP-ART91 · MX-BANK-CRYPTO · AR-PSAV · AR-FX-SPREAD · VE-OFAC.
- Labeled in the UI as "sourced · pending compliance review". It is not legal advice.
- ✓ **Follow-up resolved (Oct 17):** every rule was checked against the regulator's own text, with an independent agent trying to refute each finding. Three rules were materially wrong (BR-VASP-PENDING-WARN, BR-VASP-AUTH, VE-OFAC) and were fixed; the rest got date, wording or source fixes; two rules were added. The MX date is 2019-03-09; the AR registry dates from 2024-03-25 (CNV RG 994), with the chapter replaced by RG 1172/2026 from Oct 16. Details, quotes and the contested points are in [RULES-SOURCES.md](./RULES-SOURCES.md).

### D6. Approval policy (a light version of Agent Passport). **Decided**
- A second approver is required above **$50,000**. Daily cap is **$150,000**.

### D7. Demo data: four fictional invoices plus a registry of fictional providers. **Decided**
- Estúdio Paulista (BR, R$85,000) · Autopartes del Norte (MX, MX$1.2M) · Lucía Fernández (AR, US$4,000) · Transportes Orinoco (VE, US$12,500).
- Providers are designed so the cheapest option is non-compliant somewhere. Brazil shows **three distinct routes** on the slider: PagaFX (Sep 30) → Ponte Digital (Oct 1–30, with a "hasn't filed for BCB authorization" warning) → Sol VASP (Oct 31). See D22.
- Sol VASP being "authorized" is hypothetical: no SPSAV had been authorized as of mid-October 2026. Say so on stage.
- FX rates are labeled as demo data. The ARS pair is a 2026-10-16 snapshot: BCRA wholesale 1,518 vs. USDT/ARS 1,619. No real money moves.

### D8. The demo centerpiece is the rule-change moment. **Decided**
- Drag the as-of date Sep 30 → Oct 1 → Oct 31 and the route changes on screen, naming the rule that caused it (BR-561-EFX, then BR-VASP-AUTH). None of the competitors shows this.
- On stage, Oct 30 is the deadline to **file** for BCB authorization, not to be authorized. Use the wording in RULES-SOURCES.md §8.
- Label the Oct 31 tour step “providers that didn't file drop out,” not “transition ended” or “authorized VASP.” Explore fictional screening, fraud, radar and audit first. Manual approvals are the closing decision, followed by simulated payment and the matched Ledger entry.

## Stack

### D9. Frontend: TanStack suite. **Decided**
- **TanStack Start** (React 19) + **Router** (file routes, as-of date in the URL search param) + **Query** (all server data, fixtures switch) + **Form** (invoice fields, approver) + **Table** (inbox, route comparison, ledger). Optionally **Pacer** to debounce the slider.
- Tailwind v4 and Biome, already in `tic-web`.
- Next.js was dropped.

### D10. Bundler: keep rsbuild for now. **Open**
- The team said Vite, but `tic-web` was scaffolded with **rsbuild** (`rsbuild.config.ts`). Both work with TanStack Start.
- **Default:** keep rsbuild (it works and nobody loses time). Switching means `vite.config.ts` with the `tanstackStart()` Vite plugin, renaming env vars `PUBLIC_*` to `VITE_*`, and updating the dev scripts.
- **Owner:** FE lead decides before the first integration checkpoint.

### D11. API: Hono on Bun with Postgres 17 and Drizzle. **Decided**
- Already in `tic-api`. Follow `tic-api/DATABASE.md` (edit the schema → `db:generate` → `db:migrate` → commit `drizzle/`). Tests use `bun test`.
- CORS allows only the web origin. Request bodies are validated with `@hono/zod-validator`.

### D12. LLM: a local Llama model through Ollama, not a hosted AI API. **Decided**
- **Model:** `llama3.1:8b`, with `llama3.2:3b` as a lighter fallback (set with `LLM_MODEL`).
- **Why:** invoices and payee bank details never leave our infrastructure (a pitch point for finance buyers), no API keys or costs, and it works offline.
- **How we make an 8B model reliable:** PDF text extraction first (`unpdf`, no vision model); JSON-schema structured output; zod validation; regex and checksum pre-pass for CLABE, CNPJ and CVU numbers; temperature 0 with a fixed seed; extractions cached by PDF sha256; a guard that rejects memo citations of rules not in the plan; and a template memo if the model is down.
- Claude was dropped.

### D13. Audit trail: HMAC-SHA-512 chain plus Ed25519-signed checkpoints. **Decided**
- **Why not plain SHA-256:** it isn't broken, but anyone with DB write access can rewrite a row and recompute the chain.
- **What:** each event's MAC = HMAC-SHA-512(key, previous MAC + canonical JSON). The key lives in secrets, never in the DB. Every 10 events, and when a payout is booked, the API signs the head with Ed25519. Auditors verify with the public key. Rows carry key IDs so keys can be rotated.
- Implemented with `node:crypto` (supported in Bun).

### D14. Rails: a mock adapter by default, a real sandbox only if approved by 10:30. **Decided**
- A single `RailAdapter` interface with `mock`, `bridge` and `blindpay` implementations. The UI always shows a "simulated" badge when the mock is in use.

### D15. Hosting: BitQate. **Decided**
- `tic-api` and `tic-web` run as Docker containers built from Git. Postgres is BitQate's managed PostgreSQL. Ollama runs on a BitQate KVM VPS with the 3B model.
- **Live pitch:** run the API and Ollama on the presenting laptop for speed. The BitQate deployment is the public link for judges, with cached extractions and template memos.

### D16. Archie is out of the stack. **Decided**
- **Consequence:** we're **not eligible for the separate Archie prize** ($2.5k / $1k / $500). We still compete for the Enterprise AI track podium.

## Team and process

### D17. Team split: 3 frontend + 3 backend. **Decided**
- **FE1:** shell, inbox, slider, reroute toast, upload, `lib/api.ts`
- **FE2:** payout detail (Form, route Table, rules checklist, memo)
- **FE3:** shared components, approve/pay, ledger, audit
- **BE1:** rules engine, data, quotes, golden tests, fixtures
- **BE2:** local LLM (PDF text, extraction, memo, vendor email)
- **BE3:** DB, approvals, rails, reconciliation, audit chain, health check, BitQate deploy
- **Deck and backup video:** FE3 and BE3 from 4:30.

### D18. API contracts live in `tic-api/src/contracts.ts` and are copied to `tic-web/src/lib/contracts.ts`. **Decided**
- The API is the source of truth. Copy on every change and tell the team. Contract freeze is early, and changes after that need both leads to agree.

### D19. Frontend builds against fixtures first. **Decided**
- BE1 generates fixtures from the real engine (`scripts/fixtures.ts` → `tic-web/src/fixtures/`). Frontend switches endpoints to live one at a time and never blocks on the backend.

### D20. Ports: web on 8080, API on 3000. **Decided**
- Remove `server.port: 3000` from `tic-web/rsbuild.config.ts` to avoid confusion (the `--port 8080` flag already wins).

### D21. Docs live in both repos under `docs/`. **Decided**
- Same files in `tic-api` and `tic-web`. If you edit one, copy it to the other.

### D22. Brazil reroute moves from Oct 30 to Oct 31. **Decided**
- **What:** Ponte Digital is now a provider that is operating but **has not filed** for BCB authorization (new offramp type `vasp_unfiled`, replacing `vasp_pending`). It is warned through Oct 30 (BR-VASP-UNFILED-WARN) and blocked from Oct 31 (BR-VASP-AUTH, retitled "Missed the Oct 30 BCB filing deadline"), so Brazil reroutes to Sol VASP on **Oct 31**. The slider stop, `DEMO_DATES`, golden tests and the `plan-all.2026-10-31.json` fixture all move from Oct 30 to Oct 31. BR-VASP-PENDING-WARN no longer ends Oct 29. BR-VASP-ART91 (from Nov 6) is added. BR-521-CAP now also covers `vasp_unfiled`.
- **Why:** Oct 30, 2026 is the deadline to **file** for authorization (Res. BCB 520 art. 88 I; IN BCB 704 art. 9: "até 30 de outubro de 2026"), not a deadline to be authorized. A provider that files on time may keep operating while the BCB decides (art. 88 §6). The old demo, which blocked a pending VASP on Oct 30, had no legal basis. Oct 30 is still a valid filing day, so the earliest defensible block for a non-filer is Oct 31. From then it must stop within 30 days (art. 88 §7, about Nov 29), and from Nov 6 Brazilian banks may not deal with it (art. 91 per Res. 589). Blocking on Oct 31 is Corredor policy, and the rule message says so.
- **Alternatives considered:**
  - Keep Ponte as `vasp_pending` and reroute on Nov 6 by making BR-VASP-ART91 a block. Rejected: it rests on the literal, contested reading of the amended art. 91, which the BCB's own press note contradicts.
  - Reuse `p2p_unregistered` for the Brazilian non-filer, which needs no contract change. Rejected: the label reads wrong in the UI.
- **Consequences:** `vasp_unfiled` was added to `src/contracts.ts`, so `tic-web/src/lib/contracts.ts` must be re-copied (D18). The fixtures were regenerated. Sources and Q&A are in [RULES-SOURCES.md](./RULES-SOURCES.md).

## Open items

| # | Item | Owner | When |
|---|---|---|---|
| ~~D5~~ | ~~Verify BR/MX/AR rule dates and sources~~ Resolved Oct 17, see [RULES-SOURCES.md](./RULES-SOURCES.md) | BE1 | Done |
| D5 | Human compliance review of the rules pack (still labeled "pending compliance review") | Compliance reviewer | Before any production use |
| D5 | Re-check the OFAC Venezuela page for new general licenses (they change almost daily) | BE1 | Right before the pitch |
| D21/D22 | Copy the updated docs (incl. RULES-SOURCES.md) and `contracts.ts` to `tic-web` | BE1 | Before the first integration checkpoint after the change |
| D10 | rsbuild vs. Vite | FE lead | Before the first integration checkpoint |
| D14 | Bridge/BlindPay sandbox or mock | BE3 | 10:30 |
| — | Write access for `yoyoarmy` to `tokeico/tic-api` (pushes are currently rejected) | Repo admin | ASAP |
