import { fileURLToPath } from "node:url";
// Refresh the committed OFAC SDN snapshot in data/ (sdn.csv, alt.csv, sdn.meta.json).
// Usage: bun run scripts/sdn-update.ts
// The files are only ever parsed as CSV data. Review the diff before committing.

const BASE = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports";
const dir = fileURLToPath(new URL("../data/", import.meta.url));

for (const [remote, local] of [["SDN.CSV", "sdn.csv"], ["ALT.CSV", "alt.csv"]] as const) {
  const res = await fetch(`${BASE}/${remote}`, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${remote}: HTTP ${res.status}`);
  const text = await res.text();
  if (!/^\d+,"/.test(text)) throw new Error(`${remote}: unexpected content, not writing it`);
  await Bun.write(`${dir}${local}`, text);
  console.log(`${local}: ${text.length} bytes`);
}

const today = new Date().toISOString().slice(0, 10);
const metaPath = `${dir}sdn.meta.json`;
const meta = await Bun.file(metaPath).json();
await Bun.write(metaPath, JSON.stringify({ ...meta, version: `OFAC SDN ${today}`, downloadedAt: today }, null, 2) + "\n");
console.log(`sdn.meta.json: version OFAC SDN ${today}`);
