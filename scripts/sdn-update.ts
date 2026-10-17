import { fileURLToPath } from "node:url";
// Refresh the committed OFAC snapshot in data/: the SDN list (sdn.csv, alt.csv)
// plus the consolidated non-SDN lists (cons_prim.csv, cons_alt.csv), and
// sdn.meta.json. Usage: bun run scripts/sdn-update.ts
// The files are only ever parsed as CSV data. Review the diff before committing.

const BASE = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports";
const dir = fileURLToPath(new URL("../data/", import.meta.url));

// remote name, local file, first-row check (primaries quote col 2, aliases have a numeric alt_num there)
const FILES: [string, string, RegExp][] = [
  ["SDN.CSV", "sdn.csv", /^\d+,"/],
  ["ALT.CSV", "alt.csv", /^\d+,\d+,"/],
  ["CONS_PRIM.CSV", "cons_prim.csv", /^\d+,"/],
  ["CONS_ALT.CSV", "cons_alt.csv", /^\d+,\d+,"/],
];
for (const [remote, local, shape] of FILES) {
  const res = await fetch(`${BASE}/${remote}`, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${remote}: HTTP ${res.status}`);
  const text = await res.text();
  if (!shape.test(text)) throw new Error(`${remote}: unexpected content, not writing it`);
  await Bun.write(`${dir}${local}`, text);
  console.log(`${local}: ${text.length} bytes`);
}

const today = new Date().toISOString().slice(0, 10);
const metaPath = `${dir}sdn.meta.json`;
const meta = await Bun.file(metaPath).json();
await Bun.write(metaPath, JSON.stringify({ ...meta, version: `OFAC SDN ${today}`, downloadedAt: today }, null, 2) + "\n");
console.log(`sdn.meta.json: version OFAC SDN ${today} (loader merges cons_prim/cons_alt when present)`);
