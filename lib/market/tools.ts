/**
 * The market's callable surface, in one place.
 *
 * Lifted out of the MCP route because the agent card needs the same list and
 * Next.js will not let a route file export anything but its handlers. Two
 * hand-maintained copies was the alternative, and a card that disagrees with
 * what tools/list answers is worse than a card that says nothing -- which is
 * exactly the defect Ground's audit failed this endpoint for.
 */
/** The market's surface, described for a reader that has never seen it. */
export const TOOLS = [
  {
    name: "yuzu_broker",
    tier: "PAID",
    cost: 12,
    pricing: {
      tier: "PAID",
      cost: 12,
      currency: "arena-credits",
      isPaid: true,
      note: "Full brokered deal run. Seller payment comes out of your budget.",
    },
    description:
      "[PAID: 12 Arena credits] Plant a goal and a budget; Yuzu finds agents that answer to it, makes each prove it can do the job " +
      "before any money moves, settles a price inside your budget, and returns the finished work with a " +
      "signed receipt of who was allowed to touch what. Returns an unfilled result with a stated reason " +
      "rather than buying something when nothing meets the brief.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What you need done, in plain language." },
        budget: { type: "number", description: "Arena credits you are willing to spend. Defaults to 25." },
        capability: { type: "string", description: "Optional. Skip the capability inference and name it." },
      },
      required: ["goal"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "yuzu_assay",
    tier: "PAID",
    cost: 3,
    pricing: {
      tier: "PAID",
      cost: 3,
      currency: "arena-credits",
      isPaid: true,
      note: "Single listing evaluation.",
    },
    description:
      "[PAID: 3 Arena credits] Judge one agent listing before you trust it. Returns a verdict, a score on published weights, a " +
      "separate deterministic score that is identical on every run, and every finding quoting the sentence " +
      "that produced it. Prompt injection in a listing is detected and never obeyed.",
    inputSchema: {
      type: "object",
      properties: {
        vendor: { type: "string", description: "The seller name." },
        pitch: { type: "string", description: "The listing text, exactly as the seller wrote it." },
        askingPrice: { type: "number", description: "Optional. What the seller is asking, in credits." },
      },
      required: ["vendor", "pitch"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "yuzu_verify_receipt",
    tier: "FREE",
    cost: 0,
    pricing: {
      tier: "FREE",
      cost: 0,
      currency: "arena-credits",
      isPaid: false,
      note: "Receipt verification is 100% free.",
    },
    description:
      "[FREE: 0 Arena credits] Check a Yuzu receipt against the published Ed25519 key. Free, and you do not have to take our word " +
      "for the answer: the key and an offline script are at /api/pubkey, and this endpoint runs the same " +
      "check you would run yourself.",
    inputSchema: {
      type: "object",
      properties: { receipt: { type: "object", description: "A Yuzu receipt, whole." } },
      required: ["receipt"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "yuzu_grant_map",
    tier: "FREE",
    cost: 0,
    pricing: {
      tier: "FREE",
      cost: 0,
      currency: "arena-credits",
      isPaid: false,
      note: "Authority map lookup is free and non-consuming.",
    },
    description:
      "[FREE: 0 Arena credits] Who may touch what. The kernel answer for one actor: where it may operate, the grants behind " +
      "that reach with the part of each budget already spent, every grant that has existed, and the owner " +
      "table of decisions taken before the room opened, refusals included, because a refusal carrying no " +
      "width is why a later request cannot read a permission off the back of a no. Non-consuming.",
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string", description: "The actor to look up. Defaults to the caller." } },
      required: [],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "yuzu_sellers",
    tier: "FREE",
    cost: 0,
    pricing: {
      tier: "FREE",
      cost: 0,
      currency: "arena-credits",
      isPaid: false,
      note: "Registry search is free.",
    },
    description:
      "[FREE: 0 Arena credits] The registry: every seller, what it sells, its floor price, and a reputation that starts neutral and " +
      "moves only on a verified delivery, never on what a listing claimed about itself.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "yuzu_shortlist",
    tier: "PAID",
    cost: 10,
    pricing: {
      tier: "PAID",
      cost: 10,
      currency: "arena-credits",
      isPaid: true,
      note: "Batch evaluation of up to 12 candidate vendor listings.",
    },
    description:
      "[PAID: 10 Arena credits] Rank candidate vendor listings and generate an optimal credit allocation plan inside your budget. " +
      "Flags hostile or unproven listings and produces signed receipts per vendor.",
    inputSchema: {
      type: "object",
      properties: {
        budget: { type: "number", description: "Your total credit budget to allocate." },
        goal: { type: "string", description: "Optional goal context to align vendors against." },
        vendors: {
          type: "array",
          items: {
            type: "object",
            properties: {
              vendor: { type: "string" },
              pitch: { type: "string" },
              askingPrice: { type: "number" },
            },
            required: ["vendor", "pitch"],
          },
          description: "Listings to assay and rank.",
        },
      },
      required: ["budget", "vendors"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
] as const;
