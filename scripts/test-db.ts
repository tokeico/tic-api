const mode = Bun.argv[2] ?? "all";
const suites = mode === "all" ? ["unit", "workflow", "auth"] : [mode];
if (suites.some((suite) => !["unit", "workflow", "auth"].includes(suite))) throw new Error("Choose all, unit, workflow, or auth.");

for (const suite of suites) {
  const target = suite === "unit"
    ? "postgres://unused:unused@127.0.0.1:1/corredor_unit_test"
    : suite === "auth" ? process.env.TEST_AUTH_DATABASE_URL || process.env.TEST_DATABASE_URL : process.env.TEST_DATABASE_URL;
  if (!target) {
    if (mode !== "all") throw new Error("Set TEST_DATABASE_URL or TEST_AUTH_DATABASE_URL to a migrated local *_test database.");
    console.log(`Skipping ${suite} integration tests: no test database configured.`);
    continue;
  }
  const url = new URL(target);
  if (!url.pathname.endsWith("_test") || !["localhost", "127.0.0.1", "[::1]", "db"].includes(url.hostname)) throw new Error("Integration tests require a local database whose name ends in _test.");
  const args = ["bun", "test"];
  if (suite !== "unit") args.push(suite === "auth" ? "test/auth.test.ts" : "test/payouts.test.ts");
  if (suite === "workflow" && !Bun.argv.includes("--include-reset")) args.push("--test-name-pattern", "^(?!.*POST /api/demo/reset).*");
  console.log(`Running ${suite} tests in an isolated process.`);
  const child = Bun.spawnSync(args, {
    env: {
      ...process.env, DATABASE_URL: target, RAIL_MODE: "mock",
      TEST_DATABASE_URL: suite === "workflow" ? target : "",
      DEMO_HISTORY: suite === "workflow" ? "off" : "on",
      TEST_AUTH_DATABASE_URL: suite === "auth" ? target : "",
    },
    stdout: "inherit", stderr: "inherit",
  });
  if (child.exitCode !== 0) process.exit(child.exitCode);
}
