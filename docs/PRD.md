# Corredor — Product Requirements

**Event:** eMerge AI Hackathon 2026 · Enterprise AI track · Oct 17, 2026 (code 9 AM–6 PM, submit by 6 PM)
**Deliverables:** working demo · public repo · short deck
**Companion doc:** [ARCHITECTURE.md](./ARCHITECTURE.md)

---

## 1. One-liner

Corredor is an accounts-payable agent for paying Latin America in stablecoins. It knows each country's payment rules as of today, picks a compliant route, explains every decision with sources, reroutes when a rule changes, and books the result. **You just approve.**

## 2. Problem

US and Miami companies that pay suppliers and contractors in Latin America lose **3–7% per payment** to bank wires that take **1–5 days**. Stablecoins settle in minutes for less, but the work around the payment is still manual and risky:

| Pain | Who feels it | Today |
|---|---|---|
| Every country has different rules, and they change (Brazil changed Oct 1, 2026; crypto providers already operating must file for authorization by Oct 30) | Compliance, controller | Someone reads law-firm memos and hopes nothing changed |
| Picking the coin, network and compliant local provider | AP / treasury | Manual, done per payment, tribal knowledge |
| Sanctions exposure (Venezuela, lookalike names) | Compliance | Manual list checks, or none |
| Matching blockchain transactions to invoices and the ERP | Controller | Hashes copied from block explorers into spreadsheets at month-end |

Result: companies either keep overpaying for wires or take compliance risk they can't see.

## 3. Why we win (positioning)

- **The payment rails exist:** Bitso Business, Bridge, BlindPay, Conduit. **Stablecoin AP exists:** Ramp (since Jul 2026), Request Finance, Bitwave.
- **What's missing:** a compliance brain that works across every rail. It treats each country's rules as versioned data, checks every payment against today's rules, writes a cited memo, and reroutes on its own when a rule takes effect.
- **Private by design:** the AI runs on our own machine (Llama via Ollama). Invoices and payee bank details never go to a third-party AI service.
- **Design principle:** *AI reads and explains, code decides, a human approves.* This answers the most common CFO objection on Reddit, "AI never touches my GLs… probabilistic, not deterministic."

## 4. Users

- **Primary: Maria, a controller at a Miami importer.** About 40 LatAm payees a month across BR, MX, AR and CO. She owns approvals and month-end close and wants zero compliance surprises.
- **Secondary: an AP clerk** who forwards invoices and fixes missing payee data.
- **Viewer: an auditor or compliance reviewer** who reads the memo and audit trail.

## 5. Goals and non-goals

**Goals (today)**
1. Turn an invoice PDF into a compliant, approved, paid and booked payout, end to end.
2. Get the same decision every time for the same inputs and date, and show why, with sources.
3. Run a live rule-change moment: the as-of date moves and the route changes.
4. Make it obvious which parts are real and which are mocked.

**Non-goals (today)**
- Moving real money or holding customer funds.
- Being a licensed payment provider or giving legal advice. The rules pack is sourced but needs human compliance review.
- Covering every country. We do BR, MX, AR and VE, with CO as a stretch.
- Production auth, multi-tenancy or vendor onboarding portals.

## 6. Success criteria (mapped to the judging rubric)

| Rubric (pts) | We hit it when… |
|---|---|
| Innovation (25) | Judges see a route change live when the date crosses Oct 1, and every decision cites its rule |
| Technical (25) | The full pipeline runs live on four invoices, rules tests pass, and the audit chain verifies |
| Impact (20) | The problem is framed with real numbers and named competitors, and we say who pays |
| Design/UX (15) | One approval card per payout shows who, how much, route, cost and status at a glance |
| Pitch (15) | Three minutes, rehearsed twice, with a backup video recorded |

## 7. Core flow

```
Invoice in → Extract → Sanctions screen → Route options → Rules check (as-of date)
          → Memo → Approval (2nd approver over cap) → Pay → Reconcile → Journal entry → Audit log
```

## 8. Functional requirements

Priority: **P0** must ship for the demo · **P1** strongly wanted · **P2** stretch.

### 8.1 Invoice intake and extraction
- **P0** Upload a PDF (or pick a seeded invoice). The local Llama model extracts payee name, country, amount, currency, invoice number, due date, local bank identifier (Pix key / CLABE / CVU / account), payee tax ID (CNPJ / RFC / CUIT) and description.
- **P0** Extracted fields are editable before planning. Low-confidence fields are highlighted.
- **P1** Field validation: CLABE is 18 digits with a check digit, a CNPJ is 14 digits, a CVU is 22 digits.
- **P1** If required data is missing (for example Brazil's purpose code), the agent drafts an email to the vendor asking for it.

### 8.2 Sanctions screening
- **P0** Fuzzy-match the payee name against the OFAC SDN list. The result is clear, possible match (with score and the matched entry), or hit.
- **P0** A possible match or hit blocks the payment until a human reviews it.

### 8.3 Route options
- **P0** For each payout, list candidate routes: a SWIFT wire, plus stablecoin routes (coin, network, off-ramp provider, local rail), each with estimated cost (%, $) and time.
- **P0** Off-ramp providers and fees come from a seeded registry (demo data, labeled as such).

### 8.4 Rules engine (the core)
- **P0** Rules are data (`rules.json`). Each rule has an id, corridor, effective-from and effective-to dates, a source name and URL, a condition, an outcome (`block`, `warn` or `require_fields`) and a message.
- **P0** Takes an **as-of date** and evaluates every candidate route. The recommended route is the **cheapest compliant one**.
- **P0** Deterministic: the same inputs and as-of date always give the same result. Covered by unit tests.
- **P0** Rules pack (11 rules, verified against primary sources on Oct 17, 2026; full sourcing in [RULES-SOURCES.md](./RULES-SOURCES.md)):

| ID | Corridor | Effective | Rule | Outcome |
|---|---|---|---|---|
| BR-521-FX | BR | 2026-05-04 (Res. 521 art. 76-C; FX classification since 2026-02-02) | Stablecoin payments are FX operations; the VASP must collect a BCB purpose code and client ID | `require_fields`: purpose code, payee tax ID |
| BR-521-CAP | BR | 2026-02-02 | Non-bank VASP (SPSAV) cap of US$100k per international payment (Res. 277 art. 29 IV) | `block` the route above the cap |
| BR-561-EFX | BR | 2026-10-01 | eFX providers may not settle with their counterparty abroad in virtual assets (Res. 277 art. 50 I, per Res. 561) | `block` routes whose off-ramp is an eFX provider |
| BR-VASP-PENDING-WARN | BR | 2026-02-02 → (open-ended) | Off-ramp filed for BCB authorization on time and is waiting; it may keep operating (Res. 520 art. 88 §6) | `warn` |
| BR-VASP-UNFILED-WARN | BR | 2026-02-02 → 2026-10-30 | Off-ramp is operating but hasn't filed yet; the filing deadline is Oct 30 (Res. 520 art. 88 I; IN 704 art. 9) | `warn` |
| BR-VASP-AUTH | BR | 2026-10-31 | Off-ramp missed the Oct 30 filing deadline and must wind down (art. 88 §7). Blocking from Oct 31 is Corredor policy. | `block` |
| BR-VASP-ART91 | BR | 2026-11-06 | Brazilian banks may not deal with non-authorized VASPs (art. 91 per Res. 589); unclear whether pending filers are covered | `warn` on pending off-ramps |
| MX-BANK-CRYPTO | MX | 2019-03-09 (Banxico Circular 4/2019) | Banks and fintechs (ITFs) may not give clients crypto exchange, transfer or custody | `block` routes that off-ramp through a bank. Use a SAT-registered non-bank platform (LFPIORPI art. 17-XVI). |
| AR-PSAV | AR | 2024-03-25 (CNV RG 994; chapter replaced by RG 1172/2026 from 2026-10-16) | Off-ramps must be in the CNV PSAV registry | `block` unregistered off-ramps (policy also covers small P2P sellers who are lawfully exempt) |
| AR-FX-SPREAD | AR | — | Business risk, not a legal rule: USDT/ARS vs. BCRA wholesale rate | `warn` if the gap is over 5%, showing both rates |
| VE-OFAC | VE | — | Company policy hold pending sanctions review (targeted OFAC sanctions, not a country-wide ban) | `block` every route until compliance confirms no blocked person, owner or bank is involved |

> Verified on Oct 17 by a researcher plus an independent adversarial check against the regulators' own texts. Still labeled "pending compliance review" and not legal advice. Contested points (the Res. 589 art. 91 reading, "per payment" for the cap, the RG 994 45-day count) are listed in RULES-SOURCES.md.

### 8.5 Memo
- **P0** For each payout, the local Llama model writes a short memo covering what's being paid, the chosen route, why it complies (each rule cited with its source link), the warnings, and what a human should check. The model explains the engine's result and never overrides it. If the model is down, a template memo built from the rule messages is used.

### 8.6 Approval and mandate (Agent Passport–lite)
- **P0** One approval card per payout with approve and reject.
- **P0** Policy: payouts over **$50,000** need a second approver. A daily cap of **$150,000** applies across payouts.
- **P1** Approver identity and timestamp are recorded and shown on the card.

### 8.7 Payout execution
- **P0** The rail adapter interface has a **mock** implementation that returns realistic IDs: a transaction hash, an off-ramp reference, and a local-rail reference such as a Pix end-to-end ID.
- **P1** A **Bridge** or **BlindPay** sandbox implementation behind the same interface. Decide by 10:30 AM whether it's usable; otherwise ship the mock.
- **P0** The UI shows that the rail is simulated, with a small "sandbox / simulated" badge.

### 8.8 Reconciliation and books
- **P0** Match invoice ↔ transaction hash ↔ local rail reference. Status: matched or exception.
- **P0** Generate a journal entry: debit Accounts Payable, credit Cash (USDC), with lines for FX gain or loss and fees.
- **P1** Export a CSV in QuickBooks or NetSuite journal import format.

### 8.9 Audit log
- **P0** Append-only and hash-chained. Every step writes an event: extracted, screened, planned, memo, approved, paid, reconciled.
- **P0** A "verify chain" check in the UI shows the chain is intact.

### 8.10 Demo clock
- **P0** An as-of date slider, defaulting to today. Moving it re-runs the rules on all open payouts and animates any route change, with a "why" tooltip naming the rule that changed.

## 9. Screens

1. **Payouts inbox:** a table of invoices with payee, country flag, amount, recommended route, status pill (Ready / Needs info / Blocked / Awaiting 2nd approver / Paid / Booked) and the as-of slider at the top.
2. **Payout detail:** the extracted fields, a route comparison (wire vs. stablecoin), the rules checklist (each rule ✓ / ⚠ / ✕ with its source link), the memo, and the approve buttons.
3. **Ledger:** reconciled payouts, journal entries, export.
4. **Audit:** an event timeline with the chain-verified badge.

## 10. Demo script (3 minutes)

Seed data: four invoices, all names fictional.

| # | Payee | Amount | Expected (as of Oct 17) |
|---|---|---|---|
| 1 | Estúdio Paulista Design Ltda (São Paulo) | R$85,000 | **Ready, with warning.** USDC on Base → Ponte Digital, a VASP that hasn't filed for BCB authorization yet (deadline Oct 30) → Pix, purpose code 46978 filled. Sep 30: the cheaper eFX route (PagaFX). Oct 31: switches to the authorized VASP (Sol). |
| 2 | Autopartes del Norte S.A. de C.V. (Monterrey) | MX$1,200,000 | **Awaiting 2nd approver** (over $50k). USDC → SAT-registered non-bank platform (Puente MX) → SPEI. |
| 3 | Lucía Fernández, contractor (Buenos Aires) | US$4,000 | **Ready, with warning.** USDT on Tron → registered PSAV → CVU. Rate-spread warning shown (BCRA wholesale 1,518 vs. USDT/ARS 1,619, a 6.7% gap; business risk, not a legal rule). |
| 4 | Transportes Orinoco C.A. (Caracas) | US$12,500 | **Blocked.** VE-OFAC sanctions-review hold (company policy, not a country-wide ban). |

1. **0:00 Hook:** "Paying Latin America costs 3–7% and days. Stablecoins fix the money. Corredor fixes everything else."
2. **0:20** Drop the four invoices. Fields extract live.
3. **0:50** Statuses appear: Ready, Awaiting 2nd approver, Warning, Blocked. Open Brazil and show the route comparison and the cited rules checklist.
4. **1:30 Rule-change moment:** drag the date to Sep 30 and Brazil uses the cheaper eFX provider. Drag to Oct 1 and it reroutes ("BR-561-EFX took effect"); Ponte shows a "hasn't filed for authorization" warning. Drag to Oct 31 and it reroutes again to the authorized VASP ("BR-VASP-AUTH took effect: Missed the Oct 30 BCB filing deadline"). Back to today.
   - Say it right: Oct 30 is the deadline to **file** for authorization, not to be authorized. Oct 30 itself is still a valid filing day, which is why the reroute happens on Oct 31. Sol VASP is fictional, and no SPSAV has been authorized yet. See [RULES-SOURCES.md](./RULES-SOURCES.md) §6–8.
5. **2:00** Approve Brazil, then second-approve Mexico. Pay and show the simulated IDs.
6. **2:20** Ledger: the matched journal entry with the FX line. Audit: chain verified.
7. **2:40 Close:** "Ramp and Bitso move the money. Corredor is the compliance brain across every rail. AI reads and explains, code decides, you approve."

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Legal detail wrong | Every rule verified against primary sources on Oct 17 with an independent adversarial check ([RULES-SOURCES.md](./RULES-SOURCES.md)). Still labeled "pending compliance review"; rules that are company policy say so. |
| A judge challenges a contested reading (art. 91 and pending VASPs, the US$100k cap per payment, Venezuela) | Judge Q&A and "words to avoid" in RULES-SOURCES.md §7–8. Warn rather than block where the law is unclear. |
| A rule changes on pitch day (OFAC general licenses move almost daily; CNV RG 1172 took effect Oct 16) | Re-check the OFAC Venezuela page right before the pitch. Rules are data, so a change is one JSON row. |
| Sandbox access gated | Same rail interface plus a mock; decide at 10:30 |
| Extraction misfires live | Pinned demo PDFs, fields editable, cached extraction for the four demo invoices |
| "Ramp already does this" | Competition slide: they own the rail, we're the compliance layer across all rails |
| Local model too slow or flaky on stage | Pre-pulled and warmed model, cached extraction, template memo fallback, `llama3.2:3b` as a lighter option |

## 12. Owners (3 frontend + 3 backend)

Full split, screens and the integration timeline are in **Part 3: Frontend and team plan** (`FRONTEND.md`).

| Who | Scope |
|---|---|
| FE1 | App shell, inbox, as-of slider, reroute toast, invoice upload |
| FE2 | Payout detail: fields, route comparison, rules checklist, memo |
| FE3 | Shared components, approve and pay, ledger, audit (plus deck and video from 4:30) |
| BE1 | Rules engine, rules and demo data, quotes, golden tests, fixtures |
| BE2 | Local LLM (Ollama + Llama): PDF text, extraction, memo, vendor email |
| BE3 | DB, approvals, rail adapter, reconciliation, audit chain, deploy (plus deck and video from 4:30) |

## 13. Timeline

| Time | Milestone |
|---|---|
| 9:00 | Request sandboxes. Scaffold the app. Settle the data contracts (types in ARCHITECTURE §5). |
| 10:30 | Rail decision (sandbox or mock). Extraction works on the four PDFs. |
| 12:00 | Rules engine and tests green. Screening and quotes wired. |
| 2:00 | Memo, approvals and payout execution end to end. |
| 3:30 | Reconciliation, journal, audit chain, slider animation. |
| 4:30 | **Feature freeze.** Polish, rehearse, record backup video, deck, README. |
| 5:30 | Submit. |
