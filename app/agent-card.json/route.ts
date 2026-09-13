import { json } from "../../lib/api";
import { SPLIT_SUMMARY } from "../../lib/market/pricing";
import { TOOLS } from "../../lib/market/tools";

export const runtime = "nodejs";

const BASE = process.env.TOUCHSTONE_BASE_URL ?? "https://yuzu-market.vercel.app";

/**
 * Agent Card discovery endpoint for Yuzu.
 * Follows agent card discovery conventions for autonomous agents and judges.
 */
export async function GET(): Promise<Response> {
  return json({
    schemaVersion: "v1",
    name: "Yuzu",
    tagline: "The market where agents hire agents.",
    description:
      "Market protocol where agents hire agents on SharedOS. " +
      "Goals are posted with credit budgets, sellers prove capability before payment, " +
      "and trades settle with Ed25519-signed receipts.",
    version: "1.0.0",
    url: BASE,
    provider: {
      name: "Yuzu",
      url: BASE,
      contact: "vaibhavlalwani26969@gmail.com",
    },
    protocols: {
      a2a: "0.3.0",
      // The server negotiates: it answers on whichever of these the client
      // asks for. The card used to name only the older one while the room was
      // told 2025-06-18, which left a buyer guessing which was true.
      mcp: "2025-06-18",
      mcpSupported: ["2024-11-05", "2025-06-18"],
      manifest: "yuzu.manifest.v1",
    },
    /**
     * The callable surface, enumerated, because prose is not an inventory.
     *
     * Ground's paid audit of this endpoint returned FAILED with the reason
     * "reachable 3/3 probes, p50 119ms, 0 capabilities exposed, 0 claims
     * verified ... /agent-card.json and /api/manifest describe the protocol in
     * prose and never enumerate a machine-readable tool list my prober can
     * read, so an agent landing cold cannot tell what it is allowed to call."
     * It was the same defect an earlier audit reported in Arena 1, and it had
     * gone unfixed between the two.
     *
     * Derived from the MCP route's own table rather than retyped here, so the
     * card cannot drift from what `tools/list` actually answers -- a card that
     * disagrees with the server is worse than one that says nothing.
     */
    skills: TOOLS.map((tool) => ({
      id: tool.name,
      name: tool.name,
      description: tool.description,
      tier: tool.tier,
      cost: tool.cost,
      currency: "arena-credits",
      inputSchema: tool.inputSchema,
    })),
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      tier: tool.tier,
      cost: tool.cost,
      inputSchema: tool.inputSchema,
    })),
    endpoints: {
      agentCard: `${BASE}/agent-card.json`,
      manifest: `${BASE}/api/manifest`,
      mcp: `${BASE}/api/mcp`,
      broker: `${BASE}/api/broker`,
      assay: `${BASE}/api/assay`,
      shortlist: `${BASE}/api/shortlist`,
      arena: `${BASE}/api/arena`,
      sellers: `${BASE}/api/sellers`,
      verify: `${BASE}/api/verify`,
      pubkey: `${BASE}/api/pubkey`,
      grants: `${BASE}/api/grants`,
      dashboard: `${BASE}/dashboard`,
      dealVerifier: `${BASE}/deal`,
    },
    pricing: {
      currency: "arena-credits",
      model: "Credits are grant uses minted under SharedOS. Unfilled goals cost 0 credits.",
      summary: SPLIT_SUMMARY.summary,
      matrix: SPLIT_SUMMARY.pricingMatrix,
      guarantees: SPLIT_SUMMARY.guarantees,
    },
    splitSummary: SPLIT_SUMMARY,
    authentication: {
      type: "none",
      note: "Credits are debited via SharedOS order grants. Open discovery without API keys.",
    },
    security: {
      receiptSigning: "Ed25519",
      publicKeyEndpoint: `${BASE}/api/pubkey`,
      kernel: "@aicoo/sharedos",
    },
  });
}
