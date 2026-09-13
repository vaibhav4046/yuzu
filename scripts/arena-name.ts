/**
 * What an agent calls itself, taken from its own first sentence.
 *
 * A review headed "Review - i_5FMGzseN1Q" is a review nobody recognises as
 * theirs, and it went out that way in Arena 1 because the first pattern only
 * matched "<Name> is|here|agent". This room opens with "@Xisen - TrustSieve is
 * now live", with emoji, with bold markers, and in Chinese, so one pattern was
 * never going to hold.
 *
 * The addressee is stripped first: "@Someone - X is online" names X, not
 * Someone. That mistake scored the organiser as a competitor when the market
 * snapshot was built, which is the same bug one layer up.
 */

/**
 * Nobody a message is addressed to, and nobody who runs the event.
 *
 * `review` is here because of a live misfire: "Review - Arbiter: ..." matched
 * the `<Name> - <word>` pattern and named the *reviewer* Review, and the
 * reviewed party's text then got scored as the reviewer's own listing.
 */
const NOT_A_VENDOR =
  /^(xisen|yi ?li|everyone|here|all|organiser|organizer|team|anonymous|judge|review|reviews|rebuttal|correction|reply|note|update|notice)$/i;

const PATTERNS: readonly RegExp[] = [
  // "Galaxia ONLINE - Universal Intelligence" states the status with no verb,
  // so the bare status word counts too. Spelled out rather than carrying an
  // `i` flag, which would let the multi-word name run into ordinary prose.
  /^([A-Za-z][\w.-]{1,24}(?:\s[A-Z][\w.-]{1,16}){0,2})\s+(?:is\s+(?:now\s+)?(?:online|live|here|built|deployed|accepting)|(?:ONLINE|LIVE|online|live)\b|here\b|acknowledges\b|,\s*now\s+on)/,
  /^(?:hi[, ]+|hello[, ]+)?(?:i am|i'm)\s+([A-Za-z][\w.-]{1,24})/i,
  // Em and en dashes, not only the ASCII hyphen. Half this room opens with
  // "Receipts — the bonded market tape"; matching only `-` left those listings
  // nameless and the report went out headed with a raw seat id.
  /^([A-Za-z][\w.-]{2,24})\s*[-:–—]\s*\w/,
  /^([A-Za-z][\w.-]{2,24})\s+(?:sells|offers|provides|does|turns|takes)\b/i,
  // "A2A Interaction Intelligence is evidence-grounded observability". A
  // capitalised run followed by "is" and anything at all. Last, because it is
  // the loosest, and capitalisation is the only thing keeping it from matching
  // an ordinary sentence.
  /^([A-Z][\w.-]{2,24}(?:\s[A-Z][\w.-]{1,16}){0,3})\s+is\s+\w/,
];

export function nameIn(text: string): string | undefined {
  const cleaned = text
    // Emoji and decoration open a third of the listings in this room.
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
    .replace(/[*_`]+/g, "")
    // "@Someone -" is who it is talking to, not who is talking.
    .replace(/^[\s]*@[\w.-]+\s*[-,:]?\s*/u, "")
    .trimStart();

  for (const pattern of PATTERNS) {
    const hit = pattern.exec(cleaned)?.[1]?.trim();
    if (hit === undefined || hit.length < 3) continue;
    if (NOT_A_VENDOR.test(hit)) continue;
    if (/^(the|our|this|send|give|hand|one|what|how|and|for|with|hey|thanks|every|each)$/i.test(hit)) continue;
    return hit;
  }
  return undefined;
}
