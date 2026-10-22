import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { DEMO_INVOICES, loadSdnList, screenName } from "../src/corredor";
import { demoRoutes } from "../src/routes/demo";

const dir = fileURLToPath(new URL("../reference/presentation/", import.meta.url));

describe("fictional presentation screening", () => {
  test("all primary names and aliases are explicitly fictional", async () => {
    const list = await loadSdnList(dir);
    expect(list.version).toContain("not OFAC data");
    expect(list.entries).toHaveLength(6);
    for (const entry of list.entries) {
      expect(entry.name).toStartWith("DEMO ");
      expect(entry.primaryName).toStartWith("DEMO ");
      expect(entry.programs).toEqual(["DEMO"]);
    }
  });

  test("fictional primary names and aliases trigger the real matching algorithm", async () => {
    const list = await loadSdnList(dir);
    expect(screenName("Demo Lumen Export Ltda", list)).toMatchObject({ status: "hit", matchedEntryId: "900001" });
    expect(screenName("Demo Cobalt Cargo", list)).toMatchObject({ status: "hit", matchedEntryId: "900002" });
    for (const invoice of DEMO_INVOICES) expect(screenName(invoice.payeeName, list).status).toBe("clear");
  });

  test("sandbox responses are labeled simulated", async () => {
    const response = await demoRoutes.request("/screen?name=Demo%20Lumen%20Trading");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ simulated: true, status: "hit", matchedEntryId: "900001" });
  });

  test("the real sanctions snapshot remains separate", async () => {
    const list = await loadSdnList();
    expect(list.version).not.toContain("Fictional");
    expect(list.entries.some((entry) => entry.entryId === "26367")).toBe(true);
  });
});
