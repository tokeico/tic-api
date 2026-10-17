# Corredor: Frontend and Team Plan

Team: **3 frontend (FE1–FE3)** and **3 backend (BE1–BE3)**. Frontend builds against **fixtures** from minute one and switches to the real API one screen at a time. Nobody waits on anybody.

---

## 1. What the frontend must make obvious

Judges should get four things without anyone explaining:

1. **Status at a glance.** Each payout reads as Ready, Needs info, Blocked, Awaiting 2nd approver, Paid or Booked.
2. **Why.** Every decision shows the rule, the date it took effect and a source link.
3. **The reroute moment.** Moving the date visibly changes the route, and the app says which rule caused it.
4. **What's real vs. simulated.** Badges for "Rail: simulated" and "Rules pack v1 · pending compliance review".

## 2. Stack (repo: `tic-web`)

| Need | Use | Notes |
|---|---|---|
| App framework | **TanStack Start** (React 19) | Already scaffolded. Bundler is rsbuild (ARCHITECTURE §16). Dev on **:8080**. |
| Routing | **TanStack Router** (file routes in `src/routes`) | `index.tsx` inbox · `payouts.$id.tsx` detail · `ledger.tsx` · `audit.tsx`. Delete `about.tsx`. |
| As-of date | Router **search param** `?asOf=2026-10-17`, validated with zod | Shareable URLs; the slider writes to it; every query keys on it. |
| Server data | **TanStack Query** | `lib/api.ts` exports `queryOptions` and mutations. A `USE_FIXTURES` switch decides whether each `queryFn` reads `fixtures/` or calls the API. Mutations invalidate `["payouts"]`. |
| Forms | **TanStack Form** + zod | Invoice fields form (validation for CLABE 18 digits, CNPJ 14, CVU 22), approver picker |
| Tables | **TanStack Table** | Payouts inbox, route comparison, ledger. Sorting and column helpers. |
| Slider debounce | **TanStack Pacer** (optional) | Debounce `plan-all` calls while dragging (~150 ms) |
| Devtools | TanStack Devtools (already installed) | Router and Query panels during development |
| Styling | Tailwind v4 (already set up) · Biome for lint/format | `bun --bun run check` before pushing |

- **API URL:** `import.meta.env.PUBLIC_API_URL` (rsbuild exposes `PUBLIC_*` variables), defaulting to `http://localhost:3000`. If the team switches to Vite, rename it to `VITE_API_URL`.
- **Types:** `src/lib/contracts.ts` is a copy of `tic-api/src/contracts.ts`. Don't edit it in tic-web.
- **Formatting:** `Intl.NumberFormat` (`pt-BR` for BRL, `es-MX` for MXN, `es-AR` for ARS, `en-US` for USD). Dates show as "Oct 17, 2026".
- **Data fetching:** client-side through TanStack Query. We don't need SSR loaders for the demo.

## 3. Screens

### 3.1 Payouts inbox (home): **FE1**

| Area | Component | Data | Behavior |
|---|---|---|---|
| Top bar | `AsOfSlider` | Router search `?asOf=` | Slider plus jump buttons (Sep 30 · Oct 1 · Today · Oct 31). Use Oct 31, not Oct 30: Oct 30 is the BCB filing deadline and still a valid filing day, so nothing reroutes on it. Writes the search param; a debounced (Pacer) mutation calls `POST /api/plan-all?asOf=` and updates the Query cache. |
| Top bar | `RulesBadge`, `RailModeBadge` | `GET /api/rules?asOf=` count, `railMode` | Shows "Rules pack v1 · 9 active · pending review" and "Rail: simulated". The count is the active rules on the as-of date: 9 of the 11 on Oct 17 (BR-VASP-AUTH starts Oct 31, BR-VASP-ART91 starts Nov 6). |
| Intake | `InvoiceDropzone` | `POST /api/invoices` (multipart PDF) | Drag a PDF or pick a seeded invoice. Show a skeleton row while extracting. |
| List | `PayoutTable` (TanStack Table) | `GET /api/payouts` | Columns: payee + flag · amount (local + USD) · route chip · status pill · warnings count · open |
| Feedback | `RerouteToast` | diff of `recommended.id` before and after re-plan | "Rerouted Estúdio Paulista → Sol VASP · BR-VASP-AUTH took effect: Missed the Oct 30 BCB filing deadline" (the toast shows the `reason` from the `Reroute` object; dragging back reads "BR-VASP-AUTH not in effect on 2026-10-17: …"). The changed row flashes for about 1 s (skip the flash when `prefers-reduced-motion` is set). |

States: empty ("Drop an invoice or load the demo set"), loading skeletons, API error (inline banner with retry).

### 3.2 Payout detail (drawer or page): **FE2**

| Section | Component | Data | Behavior |
|---|---|---|---|
| Header | `PayoutHeader` | payout | Payee, country, amount, status pill, "View memo" anchor |
| Invoice | `InvoiceFieldsForm` (TanStack Form) | `invoice` | Editable fields. Anything in `lowConfidence` gets an amber outline and a "check this" hint. Save with `PATCH /api/payouts/:id`, then re-plan. |
| Screening | `ScreeningCard` | `plan.screening` | Clear / Possible match (score and matched name) / Hit |
| Routes | `RouteComparison` (TanStack Table) | `plan.evaluations[]` | One row per route: rail, coin and network, provider, fee % and $, time, status. The recommended row is highlighted and the wire is shown for contrast (for example "4.5% · 2 days"). |
| Rules | `RulesChecklist` | `evaluations[recommended].results` | Each rule shows ✓ / ⚠ / ✕ / "fields needed", its title, message, effective date and source link. Blocked routes expand to show which rule blocked them. |
| Memo | `MemoPanel` | `memo` | Summary, route rationale, warnings and checks for a human. Each cited rule ID is a chip that scrolls to the checklist. |
| Needs info | `VendorEmailDraft` (P1) | `memo.vendorEmail` | Copyable draft asking the vendor for missing fields |

### 3.3 Approve and pay: **FE3**

| Component | Data | Behavior |
|---|---|---|
| `ApprovalPanel` | `approvals[]`, policy | Approve or Reject. Above $50k it shows "1 of 2 approvals" and needs a second, different approver (pick a name from a demo dropdown: Maria Lopez / Daniel Ortiz, the seeded controller and approver. The API accepts a name, email or id). |
| `PayButton` | status `approved` | `POST /api/payouts/:id/pay`, then shows the transaction hash, off-ramp reference and Pix/SPEI/CVU reference with copy buttons and a "simulated" tag |
| `ReconcileButton` | status `paid` | `POST /api/payouts/:id/reconcile` → status `booked`, linking to the ledger |

### 3.4 Ledger: **FE3**

`JournalTable` from `GET /api/ledger`: date · payee · debit/credit lines · FX gain/loss · match status (Matched / Exception with reason). An "Export CSV" link points to `GET /api/ledger.csv`.

### 3.5 Audit: **FE3**

`AuditTimeline` from `GET /api/audit`: events newest first (type icon, payout, short payload summary, hash prefix). `ChainBadge` from `GET /api/audit/verify` shows "Chain verified · signed · 42 events" in green, or "Chain broken at #17" in red.

## 4. Shared components (build first, ~30 min): **FE3**

| Component | Spec |
|---|---|
| `StatusPill` | `ready` green · `needs_info` amber · `blocked` red · `awaiting_second_approver` amber · `approved` / `paid` / `booked` neutral with a check icon. Color is never the only signal: always text plus an icon. |
| `CountryFlag` | BR 🇧🇷 MX 🇲🇽 AR 🇦🇷 VE 🇻🇪 CO 🇨🇴, with a text code next to the flag |
| `Money` | `<Money amount currency />` using Intl, plus a USD equivalent in muted text |
| `RouteChip` | "USDC · Base · Sol VASP · 0.85%". Where the UI describes provider types, show `vasp_unfiled` as "VASP, hasn't filed for BCB authorization" and `nonbank_licensed` as "SAT-registered platform" (never "licensed"). |
| `RuleRef` | Rule ID chip with a tooltip (title and source) that links to the source |
| `SimBadge` | "Simulated" / "Demo data" tag |

## 5. API contract (frontend view)

Types come from `tic-api/src/contracts.ts` (ARCHITECTURE §5), copied to `tic-web/src/lib/contracts.ts`. **Contract freeze is 9:30.** After that, changes need both leads to agree.

| Method | Route | Returns | Used by |
|---|---|---|---|
| GET | `/api/payouts` | `PayoutSummary[]` | Inbox |
| GET | `/api/payouts/:id` | `PayoutDetail` | Detail |
| POST | `/api/invoices` | `PayoutDetail` (status `draft`, then planned) | Dropzone |
| PATCH | `/api/payouts/:id` | `PayoutDetail` | Fields form |
| POST | `/api/payouts/:id/plan?asOf=` | `PayoutDetail` | Detail refresh |
| POST | `/api/plan-all?asOf=` | `{ payouts: PayoutSummary[], reroutes: Reroute[] }` | Slider |
| POST | `/api/payouts/:id/screening-review` | `PayoutDetail` | Screening card ("Review match") |
| POST | `/api/payouts/:id/approve` | `PayoutDetail` | Approval panel |
| POST | `/api/payouts/:id/pay` | `PayoutDetail` (with `payment`) | Pay button |
| POST | `/api/payouts/:id/reconcile` | `PayoutDetail` (with `journal`) | Reconcile |
| GET | `/api/ledger` · `/api/ledger.csv` | `JournalEntry[]` · CSV | Ledger |
| GET | `/api/audit` · `/api/audit/verify` | `AuditEvent[]` · `{ ok, count, brokenAt? }` | Audit |
| GET | `/api/rules?asOf=` | `Rule[]` (active) | Rules badge |
| GET/PUT | `/api/settings` | `{ asOf, railMode, policy }` | Top bar |
| GET | `/api/health` | `{ db, ollama, model }` | Pre-demo check |

```ts
// additions to types.ts, frontend-facing
type PayoutSummary = {
  id: string; payeeName: string; country: "BR"|"MX"|"AR"|"VE"|"CO";
  amountLocal: number; currency: string; amountUsd: number;
  status: PayoutStatus; warnings: number;
  recommended: { id: string; label: string; feePct: number; minutes: number } | null;
};
type PayoutDetail = PayoutSummary & {
  invoice: Invoice; plan: Plan; memo: Memo | null;
  approvals: { approver: string; at: string }[];
  payment?: { txHash: string; offrampRef: string; railRef: string; railMode: string };
  journal?: JournalEntry;
};
type Reroute = { payoutId: string; from: string | null; to: string | null; ruleId: string; reason: string };
type Memo = { summary: string; routeRationale: string; citedRuleIds: string[];
  warnings: string[]; humanChecks: string[]; vendorEmail?: string };
```

## 6. Fixtures (so frontend never waits)

**BE1 delivers by 11:00** (from `tic-api/scripts/fixtures.ts`): `tic-web/src/fixtures/` containing `payouts.json` (the four demo payouts as of 2026-10-17) and `plan-all.<date>.json` for `2026-09-30`, `2026-10-01`, `2026-10-17` and `2026-10-31` (`DEMO_DATES` in `src/corredor/demo.ts`). Each `plan-all` file's `reroutes` are relative to the previous date in that order. Delete any old `plan-all.2026-10-30.json`. They're generated by the real rules engine, so frontend and backend agree by construction. Until 11:00, FE1 hand-writes a minimal `payouts.json` in the same shape.

Expected states (from PRD §10):

| Payout | Sep 30 | Oct 1 | Oct 17 (today) | Oct 31 |
|---|---|---|---|---|
| Estúdio Paulista (BR) | Ready · PagaFX | Ready ⚠ · Ponte (hasn't filed) | Ready ⚠ · Ponte (hasn't filed) | Ready · Sol VASP |
| Autopartes del Norte (MX) | Awaiting 2nd · Puente | same | same | same |
| Lucía Fernández (AR) | Ready ⚠ · Pampa (FX gap 6.7%) | same | same | same |
| Transportes Orinoco (VE) | Blocked (sanctions-review hold) | Blocked | Blocked | Blocked |

Reroutes in the fixtures: `plan-all.2026-09-30.json` has Ponte → PagaFX (BR-561-EFX not in effect yet), `plan-all.2026-10-01.json` has PagaFX → Ponte (BR-561-EFX took effect), `plan-all.2026-10-17.json` has none, and `plan-all.2026-10-31.json` has Ponte → Sol (BR-VASP-AUTH took effect). On Oct 1–30 Ponte's warning is BR-VASP-UNFILED-WARN. Sol VASP is fictional and "authorized" is hypothetical (no SPSAV has been authorized yet); see RULES-SOURCES.md §6.

## 7. Polish list (in priority order, after 3:30)

1. The reroute toast and row flash work perfectly at Sep 30 → Oct 1 → Oct 31.
2. The approval card looks great at 1280×720, the projector size.
3. Loading states during extraction (skeleton plus "Reading invoice…").
4. Every source link opens in a new tab.
5. Dark mode doesn't matter. Contrast on the projector does.

## 8. Team assignments

### Frontend

| Who | Owns | First 30 min |
|---|---|---|
| **FE1** | App shell, nav, inbox (TanStack Table), as-of slider (Router search param + Pacer), reroute toast, dropzone, `lib/api.ts` (TanStack Query, fixtures switch) | Routes `index`, `payouts.$id`, `ledger`, `audit`; QueryClientProvider in `__root.tsx`; hand-written fixture |
| **FE2** | Payout detail: invoice fields (TanStack Form), screening, route comparison (TanStack Table), rules checklist, memo | Detail layout against the fixture |
| **FE3** | Shared components (§4), approval and pay flow, ledger, audit | `StatusPill`, `Money`, `RouteChip`, `RuleRef` |

### Backend

| Who | Owns | First 30 min |
|---|---|---|
| **BE1** | Rules engine, `rules.json`, `offramps.json`, `fx.json`, quotes, golden tests (`bun test`), `/plan`, `/plan-all`, `/rules`, **fixtures by 11:00** | `src/contracts.ts` drafted and pushed for the contract freeze |
| **BE2** | Local LLM: Ollama client, PDF text (unpdf), extraction (regex pre-pass, sha256 cache), memo (cited-rule guard plus template fallback), vendor email. Routes `/invoices` and PATCH. Seed PDFs. | `ollama pull llama3.1:8b`, first extraction from one PDF |
| **BE3** | Drizzle schema and seed, policy and approvals, rail adapter (mock, sandbox if approved), reconciliation and journal, audit chain (HMAC-SHA-512 plus Ed25519 checkpoints), `/approve` `/pay` `/reconcile` `/ledger` `/audit` `/settings` `/health`, BitQate deploy | Request sandbox access, DB schema, seed script |

**Pitch and video:** FE3 and BE3 from 4:30, since their areas finish first. Everyone rehearses at 5:00.

## 9. Integration timeline

| Time | Frontend | Backend | Together |
|---|---|---|---|
| 9:30 | Shell and routes up | `types.ts` pushed | **Contract freeze** |
| 10:30 | Inbox and detail on hand-written fixtures | Rail decision; first extraction | |
| 11:00 | Swap to generated fixtures | **Fixtures delivered** | |
| 12:30 | Inbox on the live `/payouts` and `/plan-all` | Plan endpoints live | First live slider test |
| 2:00 | Detail, approve and pay on the live API | Memo, approvals and pay live | Full flow, one invoice |
| 3:30 | Ledger and audit live | Reconcile, journal and audit live | **All four invoices end to end** |
| 4:30 | Feature freeze → polish list | Feature freeze → hardening, seed reset | Record the backup video |
| 5:30 | | | **Submit** |

**Integration rule:** if an endpoint isn't live when frontend needs it, frontend stays on fixtures. Never block on the backend.
