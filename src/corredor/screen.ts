// OFAC SDN screening: fuzzy-match a payee name against the SDN list
// (primary names from sdn.csv plus aliases from alt.csv).
//
// Result: clear, possible_match (with score and matched entry) or hit.
// A possible_match or hit blocks the payout until a human reviews it (PRD 8.2).
// Pure once the list is loaded; loading reads the committed snapshot in data/.

import { fileURLToPath } from "node:url";
import type { ScreeningStatus } from "../contracts";

export interface SdnEntry {
  /** SDN ent_num (as a string). Aliases share the primary entry's id. */
  entryId: string;
  /** Name as listed (primary or alias). */
  name: string;
  /** Primary SDN name, for display when `name` is an alias. */
  primaryName: string;
  type: string; // "entity" | "individual" | "vessel" | "aircraft"
  programs: string[];
  tokens: string[];
}

export interface SdnList {
  version: string;
  entries: SdnEntry[];
}

export interface ScreeningResult {
  status: ScreeningStatus;
  match?: string;
  score?: number;
  matchedEntryId?: string;
  programs?: string[];
  listVersion: string;
}

export interface ScreeningThresholds {
  /** Score at or above this is a hit. */
  hit: number;
  /** Score at or above this is a possible match. */
  possible: number;
}

export const DEFAULT_THRESHOLDS: ScreeningThresholds = { hit: 0.97, possible: 0.88 };

// ---- CSV ------------------------------------------------------------------------

/** RFC 4180 CSV parser (quoted fields, doubled quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\x1a") field += c; // OFAC files end with a ^Z byte
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

const nullable = (s: string | undefined): string | null => {
  const t = (s ?? "").trim();
  return t === "" || t === "-0-" ? null : t;
};

// ---- Normalisation -----------------------------------------------------------------

/** Corporate suffixes and connector words that carry no identity. */
const STOPWORDS = new Set([
  "S", "A", "SA", "SAS", "SRL", "SPA", "SAPI", "SC", "CV", "C", "V", "CA", "LTDA", "LTD", "LLC", "LP", "LLP",
  "INC", "CO", "CORP", "CORPORATION", "COMPANY", "LIMITED", "GMBH", "AG", "BV", "NV", "PLC", "EIRELI", "ME",
  "DE", "DEL", "LA", "LAS", "LOS", "EL", "Y", "E", "DO", "DA", "DOS", "DAS", "THE", "OF", "AND",
]);

export function normalizeName(name: string): string[] {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    // Dotted acronyms collapse before punctuation stripping: "P.D.V.S.A." → "PDVSA".
    .replace(/\b(?:[A-Z]\.){2,}[A-Z]?\.?/g, (m) => m.replace(/\./g, ""))
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t !== "" && !STOPWORDS.has(t));
}

// ---- Similarity --------------------------------------------------------------------

/** Jaro-Winkler similarity in [0, 1]. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 0;
  const window = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const aMatch = new Array<boolean>(la).fill(false);
  const bMatch = new Array<boolean>(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(i + window + 1, lb);
    for (let j = lo; j < hi; j++) {
      if (!bMatch[j] && a[i] === b[j]) {
        aMatch[i] = bMatch[j] = true;
        matches++;
        break;
      }
    }
  }
  if (matches === 0) return 0;
  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < la; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const m = matches;
  const jaro = (m / la + m / lb + (m - transpositions / 2) / m) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, la, lb) && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Token pairs below this similarity count as unrelated (score 0). Without a
 *  floor, Jaro-Winkler gives ~0.6 to random pairs and inflates every score. */
export const TOKEN_FLOOR = 0.85;

/** Token similarity: identical → 1; a single letter matching the longer
 *  token's initial → 0.9 ("N." vs "NICOLAS", either direction); otherwise
 *  Jaro-Winkler. */
export function tokenSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 1 && b.length > 1 && b.startsWith(a)) return 0.9;
  if (b.length === 1 && a.length > 1 && a.startsWith(b)) return 0.9;
  return jaroWinkler(a, b);
}

/** How well `from`'s tokens are covered by `to`'s, weighted by token length. */
function coverage(from: string[], to: string[]): number {
  let total = 0;
  let weight = 0;
  for (const t of from) {
    let best = 0;
    for (const u of to) {
      const s = tokenSimilarity(t, u);
      if (s > best) best = s;
      if (best === 1) break;
    }
    total += (best >= TOKEN_FLOOR ? best : 0) * t.length;
    weight += t.length;
  }
  return weight === 0 ? 0 : total / weight;
}

/**
 * Order-insensitive similarity between a payee name (`query`) and an SDN
 * name (`listed`). Weighted toward how much of the payee name is explained
 * by the listed name, with a smaller weight the other way so a single shared
 * word ("TRANSPORTES") doesn't flag. Token order doesn't matter
 * ("ZERPA DELGADO, Simon" vs. "Simon Zerpa Delgado").
 */
export function nameScore(query: string[], listed: string[]): number {
  if (query.length === 0 || listed.length === 0) return 0;
  if (query.join(" ") === listed.join(" ")) return 1;
  const covQuery = coverage(query, listed);
  const covListed = coverage(listed, query);
  let score = 0.65 * covQuery + 0.35 * covListed;
  // Subset boost: the query is fully covered by a longer listed name
  // ("Maduro Moros" vs "MADURO MOROS, Nicolas", "N. Maduro" via initials).
  // Requires real tokens (an initial alone isn't enough) and at least half of
  // the listed name explained, so one shared word still can't flag.
  const fullyCovered =
    query.length >= 2 &&
    query.some((t) => t.length >= 3) &&
    query.every((t) => listed.some((u) => tokenSimilarity(t, u) >= TOKEN_FLOOR)) &&
    covQuery >= 0.97 &&
    covListed >= 0.5;
  if (fullyCovered) score = Math.max(score, 0.9);
  return score;
}

// ---- List loading -------------------------------------------------------------------

/**
 * Build the list from sdn.csv (+ optional alt.csv) text. Extra primary/alias
 * pairs (the OFAC consolidated list) merge into the same entry set; alias
 * rows resolve against every primary loaded so far. */
export function buildSdnList(sdnCsv: string, altCsv: string | null, version: string, extra: { prim: string; alt: string | null }[] = []): SdnList {
  const entries: SdnEntry[] = [];
  const primary = new Map<string, { name: string; type: string; programs: string[] }>();
  // *.csv: ent_num, Name, Type, Program, ... (same layout for SDN.CSV and CONS_PRIM.CSV)
  for (const prim of [sdnCsv, ...extra.map((e) => e.prim)]) {
    for (const row of parseCsv(prim)) {
      const id = nullable(row[0]);
      const name = nullable(row[1]);
      if (!id || !name) continue;
      const type = nullable(row[2]) ?? "entity";
      const programs = (nullable(row[3]) ?? "").split(/\]\s*\[/).map((p) => p.replace(/[[\]]/g, "").trim()).filter(Boolean);
      primary.set(id, { name, type, programs });
      entries.push({ entryId: id, name, primaryName: name, type, programs, tokens: normalizeName(name) });
    }
  }
  // alt.csv / cons_alt.csv: ent_num, alt_num, alt_type, alt_name, alt_remarks
  for (const alt of [altCsv, ...extra.map((e) => e.alt)]) {
    if (!alt) continue;
    for (const row of parseCsv(alt)) {
      const id = nullable(row[0]);
      const name = nullable(row[3]);
      const p = id ? primary.get(id) : undefined;
      if (!id || !name || !p) continue;
      entries.push({ entryId: id, name, primaryName: p.name, type: p.type, programs: p.programs, tokens: normalizeName(name) });
    }
  }
  return { version, entries: entries.filter((e) => e.tokens.length > 0) };
}

/** Load the committed snapshot (data/sdn.csv + data/alt.csv + data/sdn.meta.json,
 *  plus the consolidated non-SDN lists when scripts/sdn-update.ts fetched them). */
export async function loadSdnList(dir = fileURLToPath(new URL("../../data/", import.meta.url))): Promise<SdnList> {
  const altFile = Bun.file(`${dir}alt.csv`);
  const consPrimFile = Bun.file(`${dir}cons_prim.csv`);
  const consAltFile = Bun.file(`${dir}cons_alt.csv`);
  const metaFile = Bun.file(`${dir}sdn.meta.json`);
  const [sdn, alt, consPrim, consAlt, meta] = await Promise.all([
    Bun.file(`${dir}sdn.csv`).text(),
    (await altFile.exists()) ? altFile.text() : null,
    (await consPrimFile.exists()) ? consPrimFile.text() : null,
    (await consAltFile.exists()) ? consAltFile.text() : null,
    (await metaFile.exists()) ? (metaFile.json() as Promise<{ version?: string }>) : ({} as { version?: string }),
  ]);
  const extra = consPrim ? [{ prim: consPrim, alt: consAlt }] : [];
  const version = (meta.version ?? "OFAC SDN (unversioned snapshot)") + (consPrim ? " + Consolidated" : "");
  return buildSdnList(sdn, alt, version, extra);
}

// ---- Screening -------------------------------------------------------------------------

export function screenName(
  payeeName: string,
  list: SdnList,
  thresholds: ScreeningThresholds = DEFAULT_THRESHOLDS,
): ScreeningResult {
  const query = normalizeName(payeeName);
  let best: SdnEntry | null = null;
  let bestScore = 0;
  for (const e of list.entries) {
    // Compare on the rounded score so float noise doesn't defeat the tie-break.
    const s = Math.round(nameScore(query, e.tokens) * 10000) / 10000;
    // Ties → lowest entry id, so the result is deterministic.
    if (s > bestScore || (s === bestScore && best !== null && s > 0 && Number(e.entryId) < Number(best.entryId))) {
      best = e;
      bestScore = s;
    }
  }
  const score = bestScore;
  if (!best || score < thresholds.possible) return { status: "clear", listVersion: list.version };
  const match = best.name === best.primaryName ? best.name : `${best.name} (a.k.a. of ${best.primaryName})`;
  return {
    status: score >= thresholds.hit ? "hit" : "possible_match",
    match,
    score,
    matchedEntryId: best.entryId,
    programs: best.programs,
    listVersion: list.version,
  };
}
