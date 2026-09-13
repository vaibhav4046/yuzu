import { describe, expect, it } from "vitest";
import { GET as card } from "../app/agent-card.json/route";
import { TOOLS } from "../lib/market/tools";

/**
 * A discovery document that describes the protocol in prose is not discovery.
 *
 * Ground's paid audit of this endpoint (Arena 2, txn_eDGZQGxa62) returned
 * verdict FAILED on a service that was up and fast:
 *
 *   "reachable 3/3 probes, p50 119ms, 0 capabilities exposed, 0 claims
 *    verified ... /agent-card.json and /api/manifest describe the protocol in
 *    prose and never enumerate a machine-readable tool list my prober can
 *    read, so an agent landing cold cannot tell what it is allowed to call."
 *
 * An earlier audit had reported the same thing in Arena 1 and it went unfixed
 * between the two rounds, which is the part worth a regression test: the card
 * is now derived from the MCP route's own table, and this fails if the two ever
 * disagree again.
 */
describe("the agent card enumerates the surface the server actually answers", () => {
  it("lists every tool tools/list returns", async () => {
    const body = await (await card()).json();

    expect(Array.isArray(body.skills)).toBe(true);
    expect(body.skills).toHaveLength(TOOLS.length);
    expect(body.skills.map((skill: { id: string }) => skill.id).sort()).toEqual(
      TOOLS.map((tool) => tool.name).sort(),
    );
  });

  it("gives every tool a price and a callable input schema", async () => {
    const body = await (await card()).json();

    for (const skill of body.skills as ReadonlyArray<{ id: string; tier: string; cost: number; inputSchema?: unknown }>) {
      expect(["PAID", "FREE"], `${skill.id} tier`).toContain(skill.tier);
      expect(typeof skill.cost, `${skill.id} cost`).toBe("number");
      expect(skill.inputSchema, `${skill.id} schema`).toBeDefined();
    }
  });

  /**
   * The card named 2024-11-05 while the room was told 2025-06-18. The server
   * negotiates either, so neither statement was false on its own and a buyer
   * still could not tell which to send.
   */
  it("names the protocol versions the server negotiates, not one of them", async () => {
    const body = await (await card()).json();

    expect(body.protocols.mcpSupported).toContain("2024-11-05");
    expect(body.protocols.mcpSupported).toContain("2025-06-18");
    expect(body.protocols.mcpSupported).toContain(body.protocols.mcp);
  });
});
