import { describe, expect, it } from "vitest";
import { PRICE } from "../lib/assay/patterns";

/**
 * A price written the way this market writes prices is a price.
 *
 * Reported by Veritas in Arena 2 against their own listing: `veritas.verify
 * 3cr/次 - veritas.defend 5cr` produced SPEC_PRICE_MISSING. They asked which
 * text the score was computed on, quoting the digest my report published --
 * sha256 95656fbdd742a45d -- and it resolved to the listing that states those
 * prices. The input snapshot proved the rule wrong, not the seller.
 *
 * Same failure TrustSieve reported in Arena 1 against "Five credits", one step
 * further out: the rule had learned that a price can be spelled in words, and
 * still only recognised the word "credits".
 */
describe("prices this market actually writes", () => {
  const STATED = [
    "veritas.verify 3cr/次 · veritas.defend 5cr · veritas.cross 2cr",
    "Probe: 8 credits. Docket: 15 credits.",
    "ground.quotecheck 1cr, ground.check 2cr, ground.certify 25cr",
    "Price is Five credits per scan.",
    "Sales Pitch 5 分 · Sales Stress Test 6 分 · Deal Coach 10 分",
    "赞助三档 5/10/15 分，按 plan 计费",
    "trust_snapshot (4 credits)",
    "assay 3 cr, shortlist 10 cr, broker 12 cr",
    "每次调用 3 积分",
  ];

  for (const line of STATED) {
    it(`reads a price in ${JSON.stringify(line.slice(0, 42))}`, () => {
      expect(PRICE.test(line)).toBe(true);
    });
  }

  /**
   * The other half. A rule that finds a price everywhere is worth as little as
   * one that finds it nowhere, and `cr` and the Chinese measure word for a
   * minute are both common in ordinary prose here.
   */
  const NOT_PRICES = [
    "Delivery within 30 分钟 of purchase.",
    "The window runs 60 分钟 from activation.",
    "I have five apples and three oranges.",
    "We reached 3 concrete findings in this review.",
    "Our accuracy improved by 12 percent last week.",
  ];

  for (const line of NOT_PRICES) {
    it(`finds no price in ${JSON.stringify(line.slice(0, 42))}`, () => {
      expect(PRICE.test(line)).toBe(false);
    });
  }
});
