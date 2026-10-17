const WITHHELD = "Restricted-list entry (name withheld in demo)";
const sensitiveName = /\b(?:maduro|hezbollah|hezbolla|hezbolah|hezbullah|hizballah|hizbollah|hizbullah|shezbolla)\b/gi;
const opaque = new Set(["payload", "hash", "prev", "prevHash", "signature", "fingerprint", "id", "payoutId", "entryId", "matchedEntryId", "txHash"]);

export function demoPresentation(value: unknown): unknown {
  const names = new Set<string>();
  const collect = (item: unknown, fictional = false) => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) {
      item.forEach((v) => collect(v, fictional));
      return;
    }
    const row = item as Record<string, unknown>;
    const demo = fictional || row.simulated === true || (typeof row.listVersion === "string" && row.listVersion.startsWith("Fictional"));
    for (const [key, v] of Object.entries(row)) {
      if (!demo && ["match", "matchedName", "primaryName"].includes(key) && typeof v === "string" && v.trim() && !v.startsWith("DEMO ")) names.add(v);
      collect(v, demo);
    }
  };
  collect(value);
  const mask = (text: string) => {
    for (const name of names) text = text.replaceAll(name, WITHHELD);
    return text.replace(sensitiveName, WITHHELD);
  };
  const visit = (item: unknown, key = ""): unknown => {
    if (opaque.has(key)) return item;
    if (typeof item === "string") return mask(item);
    if (Array.isArray(item)) return item.map((v) => visit(v, key));
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, visit(v, k)]));
    return item;
  };
  return visit(value);
}
