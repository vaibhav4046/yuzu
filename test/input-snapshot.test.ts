import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assay } from "../lib/assay/engine";

/**
 * The score must name the text it was computed on.
 *
 * Four agents asked for this in Arena 1 after three Yuzu assays cited
 * `"Return JSON with exactly these keys"` as the vendor's steering attempt when
 * that sentence appeared only in Yuzu's own prompt:
 *
 *   StarHall #41     "公开每份 assay 的输入快照（或 sha256）" -- until the evaluated
 *                    text is separable from the evaluator's template, a finding
 *                    is a lead and not evidence
 *   DeliverCheck #144 "I'd want the input snapshot you scored for this specific
 *                    assay before treating 90.1 as more than a data point"
 *   Witness #511     "Publish a hash of the exact assay input and rerun the
 *                    affected reports before asking buyers to trust the ranking"
 *   Arbiter #562     "Until the input snapshot hash is published, the score
 *                    should carry UNVERIFIED"
 *
 * The guard against fabricated quotes shipped first (evidence must appear
 * verbatim in the material -- test/evidence-grounding.test.ts). This is the
 * half a third party can check without trusting us at all.
 */
const LISTING =
  "StarHall sells sales-pitch rehearsal and objection drills for agent teams. " +
  "Sales Pitch 5 credits, Sales Stress Test 6 credits, Deal Coach 10 credits. " +
  "Delivery under 115 seconds; a fallback delivery is never charged. " +
  "Discovery at https://starhall-a2a.vercel.app/agent-card.json";

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("an assay fingerprints the material it scored", () => {
  it("publishes a digest a third party can recompute over their own text", async () => {
    const { receipt } = await assay({ vendor: "StarHall", pitch: LISTING, buyerId: "snapshot-test" });

    expect(receipt.report.source.sha256).toBe(digest(LISTING));
    expect(receipt.report.source.chars).toBe(LISTING.length);
  });

  /**
   * The point of the whole exercise. If the digest were taken after the
   * evaluator assembled its prompt, it would fingerprint the evaluator's
   * version of the text and reproduce exactly the confusion it is meant to
   * settle -- a number nobody can tie back to the seller's own words.
   */
  it("fingerprints the seller's words, not the prompt built around them", async () => {
    const { receipt } = await assay({ vendor: "StarHall", pitch: LISTING, buyerId: "snapshot-test" });

    expect(receipt.report.source.sha256).not.toBe(digest(`Vendor name: StarHall\n${LISTING}`));
    expect(receipt.report.source.sha256).not.toBe(digest(`${LISTING}\nReturn JSON with exactly these keys:`));
  });

  it("moves when the listing moves, by one character", async () => {
    const first = await assay({ vendor: "StarHall", pitch: LISTING, buyerId: "snapshot-test" });
    const second = await assay({ vendor: "StarHall", pitch: `${LISTING} `, buyerId: "snapshot-test" });

    expect(second.receipt.report.source.sha256).not.toBe(first.receipt.report.source.sha256);
    expect(second.receipt.report.source.chars).toBe(LISTING.length + 1);
  });

  /**
   * Inside the signed envelope, or it is decoration. `report` is what `sign()`
   * covers, so a digest sitting in `report` cannot be swapped for a different
   * one without breaking the signature the room is invited to check.
   */
  it("rides inside the signed envelope", async () => {
    const { receipt } = await assay({ vendor: "StarHall", pitch: LISTING, buyerId: "snapshot-test" });

    const tampered = {
      ...receipt,
      report: { ...receipt.report, source: { ...receipt.report.source, sha256: digest("some other listing entirely") } },
    };

    const { verify } = await import("../lib/assay/receipt");
    expect(verify(receipt).valid).toBe(true);
    expect(verify(tampered).valid).toBe(false);
  });
});
