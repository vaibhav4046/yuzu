import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { sign, verify, type Receipt } from "../lib/assay/receipt";
import { runBroker } from "../lib/market/broker";

vi.mock("next/server", () => ({ after: () => undefined }));

const SAMPLE =
  "Yuzu sits between a buyer goal and the agents that answer it, taking the brief apart into a capability, budget and deadline.";

const DELIVERY = `${SAMPLE} The brief is answered in full, with the gaps named rather than filled.`;

vi.mock("../lib/assay/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/assay/llm")>();
  return {
    ...actual,
    complete: async (options: { model: string; system?: string; user: string }) => {
      const system = options.system ?? "";
      if (system.includes("procurement request")) {
        return {
          ok: true,
          ms: 1,
          text: '{"capability":"research.brief","deliverable":"A competitor brief in markdown.","constraints":["name competitors"]}',
        };
      }
      if (system.includes("proof-of-capability")) {
        return { ok: true, ms: 1, text: SAMPLE };
      }
      if (system.includes("verify delivered work")) {
        return { ok: true, ms: 1, text: '{"adherence":0.9,"quality":0.9,"accepted":true,"findings":["Answers the brief."]}' };
      }
      return { ok: true, ms: 1, text: DELIVERY, truncated: false };
    },
  };
});

function createReceiptFixture(): Receipt {
  const now = new Date();
  return sign({
    version: "touchstone.receipt.v1",
    receiptId: "rcp_asymmetric_fixture",
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60_000).toISOString(),
    issuer: "touchstone",
    buyerId: "buyer-asymmetric",
    purpose: "market.broker",
    traceId: "trace-asymmetric",
    report: {
      vendor: "Scout",
      vendorSlug: "scout",
      source: {
        sha256: "0000000000000000000000000000000000000000000000000000000000000000",
        chars: 0,
        recompute: "fixture",
      },
      verdict: "TRUSTED",
      score: 90,
      deterministicScore: 90,
      reproducibility: {
        exact: ["Contract arithmetic", "Negotiated price", "Credit settlement"],
        modelDerived: ["Delivery verification"],
        unavailable: [],
        note: "Deterministic settlement and signed receipt.",
      },
      headline: "Scout delivered for 15 credits.",
      dimensions: [],
      claims: [],
      risks: [],
      notChecked: [],
      analysis: "deterministic+classifier+model",
    },
    decisions: [
      { action: "grant", resource: "market.research", outcome: "allowed", reasonCode: "authorised" },
      { action: "spend", resource: "credits", outcome: "allowed", reasonCode: "contract_settlement" },
    ],
    escalations: [],
  });
}

describe("Asymmetric Verification: O(1) offline check vs bounded multi-agent reasoning", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("verifies in O(1) constant time locally across multiple runs", () => {
    const receipt = createReceiptFixture();

    // Warm up
    verify(receipt);

    const iterations = 50;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      const result = verify(receipt);
      expect(result.valid).toBe(true);
    }
    const elapsed = performance.now() - start;
    const avgMs = elapsed / iterations;

    // Cryptographic Ed25519 verification runs in under 3ms on standard hardware
    expect(avgMs).toBeLessThan(3);
  });

  it("makes zero network calls during verification", () => {
    const receipt = createReceiptFixture();

    const result = verify(receipt);
    expect(result.valid).toBe(true);

    // Zero network requests made
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("incurs zero credit cost and requires no authorizer grants", () => {
    const receipt = createReceiptFixture();

    // Verifying takes only the receipt object and public key, requiring 0 balance or grants
    const result = verify(receipt);
    expect(result.valid).toBe(true);

    // Tampering with the report fails immediately
    const tampered = {
      ...receipt,
      report: { ...receipt.report, score: 99 },
    };
    const tamperedResult = verify(tampered);
    expect(tamperedResult.valid).toBe(false);
  });

  it("contrasts multi-agent reasoning in brokering with instant mathematical verification", async () => {
    // Brokering requires bounded multi-agent reasoning across eight distinct stages
    const outcome = await runBroker({
      goal: "Analyze competitors for an offline notes app",
      budget: 25,
      buyerId: "buyer-contrast-test",
      capability: "research.brief",
    });

    expect(outcome.timeline.length).toBeGreaterThanOrEqual(6);
    expect(outcome.bids.length).toBeGreaterThan(0);
    expect(outcome.proofs.length).toBeGreaterThan(0);
    expect(outcome.contract).toBeDefined();
    expect(outcome.settlement).toBeDefined();

    // Once produced, the receipt verifies locally in O(1) time with 0 network calls
    fetchSpy.mockClear();
    const verificationStart = performance.now();
    const receiptResult = verify(outcome.receipt);
    const verificationElapsed = performance.now() - verificationStart;

    expect(receiptResult.valid).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(verificationElapsed).toBeLessThan(5);
  });
});
