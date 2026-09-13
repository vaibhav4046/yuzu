import { describe, expect, it } from "vitest";
import { packReceipt, unpackReceipt, sign, verify } from "../lib/assay/receipt";
import { assay } from "../lib/assay/engine";

/**
 * A receipt id nobody can fetch is a citation to a book with no library.
 *
 * Two agents who had paid to check Yuzu were blocked by the same gap in
 * Arena 2. Ground: "your /api/verify wants the receipt body, not its id."
 * Veritas, asked to verify Yuzu's own published correction, returned
 * credibility 25/100 and "cannot determine -- no URL, room events are not in
 * the public corpus."
 *
 * Storing receipts was the obvious answer and the wrong one: it would put the
 * evidence for a signature behind mutable state the issuer controls. The whole
 * receipt rides inside the link instead.
 */
describe("a receipt survives the round trip through a link", () => {
  it("comes back byte-identical", async () => {
    const { receipt } = await assay({ vendor: "Ground", pitch: "Ground - ground.check 2cr, one claim, one verdict, one proof. Signed receipts.", buyerId: "link-test" });

    const restored = unpackReceipt(packReceipt(receipt));

    expect(restored).toEqual(receipt);
  });

  it("still verifies after the round trip, which is the only thing that matters", async () => {
    const { receipt } = await assay({ vendor: "Ground", pitch: "Ground - ground.check 2cr, one claim, one verdict, one proof. Signed receipts.", buyerId: "link-test" });

    const restored = unpackReceipt(packReceipt(receipt));

    expect(verify(restored).valid).toBe(true);
  });

  /**
   * The link must not become a way to launder an edited receipt: a packed
   * receipt whose contents were changed has to fail the same signature check
   * as one handed over any other way.
   */
  it("does not launder a tampered receipt", async () => {
    const { receipt } = await assay({ vendor: "Ground", pitch: "Ground - ground.check 2cr, one claim, one verdict, one proof. Signed receipts.", buyerId: "link-test" });

    const tampered = { ...receipt, report: { ...receipt.report, score: 100, verdict: "TRUSTED" as const } };
    const restored = unpackReceipt(packReceipt(tampered as typeof receipt));

    expect(restored).toBeDefined();
    expect(verify(restored).valid).toBe(false);
  });

  it("reports rubbish as unreadable rather than as invalid", () => {
    expect(unpackReceipt("not-a-receipt")).toBeUndefined();
    expect(unpackReceipt("")).toBeUndefined();
  });
});
