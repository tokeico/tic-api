import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { db } from "./db";
import { isIsoDate, reference, rulesActiveOn } from "./corredor";
import { demoPresentation } from "./presentation";
import { getPayout, listPayouts, previewPlan } from "./services/payouts";
import { verifyAuditLog } from "./services/audit-log";
import { listLedger } from "./services/ledger";
import { getDemoAsOf } from "./services/settings";

export async function handleMcp(request: Request): Promise<Response> {
  const server = new McpServer({ name: "corredor", version: "1.0.0" }, {
    instructions: "Read-only compliance evidence and dated route decisions for the authenticated workspace. No tool approves payments, moves money, clears holds, or verifies a person's identity. Simulated results are not real KYC verification.",
  });
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const result = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify((process.env.RAIL_MODE ?? "mock") === "mock" ? demoPresentation(value) : value) }],
  });
  server.registerTool("list_payouts", { description: "List this workspace's payouts and stable IDs. Route eligibility is not identity verification.", inputSchema: z.object({}), annotations }, async () => result(await listPayouts()));
  server.registerTool("get_payout", { description: "Read one payout, its dated checks, citations and approval history. Only IDs from this workspace resolve.", inputSchema: z.object({ id: z.string().uuid() }), annotations }, async ({ id }) => result(await getPayout(id)));
  server.registerTool("preview_route", { description: "Dry-run a payout's route on a date. Stores nothing and grants no approval.", inputSchema: z.object({ id: z.string().uuid(), asOf: z.string().refine(isIsoDate, "Use a real YYYY-MM-DD date.") }), annotations }, async ({ id, asOf }) => result(await previewPlan(id, asOf)));
  server.registerTool("list_rules", { description: "Read cited route rules, optionally limited to those active on a date.", inputSchema: z.object({ asOf: z.string().refine(isIsoDate).optional(), all: z.boolean().optional() }), annotations }, async ({ asOf, all }) => result(all ? reference().rules : rulesActiveOn(asOf ?? await getDemoAsOf(db))));
  server.registerTool("list_ledger", { description: "Read reconciled journal entries in this workspace.", inputSchema: z.object({}), annotations }, async () => result(await listLedger()));
  server.registerTool("verify_audit_log", { description: "Verify this workspace's audit MACs and signed checkpoints. Does not alter evidence.", inputSchema: z.object({}), annotations }, async () => result(await verifyAuditLog()));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(await response.arrayBuffer(), { status: response.status, headers });
  } finally {
    await server.close();
  }
}
