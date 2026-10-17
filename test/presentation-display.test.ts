import { expect, test } from "bun:test";
import { demoPresentation } from "../src/presentation";

test("demo display masks real screening names in matches, memos and reasons without clearing a hit", () => {
  const input = {
    status: "blocked",
    screening: { status: "hit", match: "REAL RESTRICTED ORGANIZATION", matchedEntryId: "1234", score: 1 },
    memo: { text: 'Blocked against "REAL RESTRICTED ORGANIZATION".' },
    reasons: ["REAL RESTRICTED ORGANIZATION needs review."],
  };
  const output = demoPresentation(input) as typeof input;
  expect(output.status).toBe("blocked");
  expect(output.screening.status).toBe("hit");
  expect(output.screening.score).toBe(1);
  expect(output.screening.matchedEntryId).toBe("1234");
  expect(JSON.stringify(output)).not.toContain("REAL RESTRICTED ORGANIZATION");
  expect(input.screening.match).toBe("REAL RESTRICTED ORGANIZATION");
});

test("fictional screening names remain readable", () => {
  const input = { simulated: true, match: "DEMO LUMEN TRADING", status: "hit" };
  expect(demoPresentation(input)).toEqual(input);
});

test("redacting displayed history does not alter canonical audit evidence", () => {
  const input = { summary: "A real matched name was reviewed", payload: '{"summary":"A real matched name was reviewed"}', screening: { matchedName: "A real matched name" }, hash: "abc123" };
  const output = demoPresentation(input) as typeof input;
  expect(output.summary).toContain("name withheld in demo");
  expect(output.payload).toBe(input.payload);
  expect(output.hash).toBe(input.hash);
});

test("sensitive names and spelling variants are masked even in free-form agent answers", () => {
  for (const name of ["Ma" + "duro", "Hez" + "bollah", "Hiz" + "ballah", "shez" + "bolla", "Hez" + "bolla"]) {
    const input = { text: `Review ${name} before paying`, error: { message: name.toUpperCase() } };
    const output = demoPresentation(input) as typeof input;
    expect(output.text).not.toContain(name);
    expect(output.error.message).not.toContain(name.toUpperCase());
  }
});
