import { publicKeyDocument, unpackReceipt, verify } from "../../../lib/assay/receipt";
import { json } from "../../../lib/api";

export const runtime = "nodejs";

/**
 * Anyone can check a Touchstone receipt.
 *
 * A verdict that only Touchstone can confirm is a verdict you have to trust.
 * Receipts are signed with Ed25519 and the public key is served from here and
 * from `/api/pubkey`, so this endpoint is a convenience rather than an
 * authority: it runs the same public-key check a rival vendor or a judge can
 * run on their own machine, against the same published key. If we lied about a
 * result here, the offline script in the GET body would say so.
 */

/**
 * Why a receipt failed matters as much as that it failed.
 *
 * `signature_mismatch` means the bytes were edited. The two below mean nothing
 * of the sort — they are receipts this deployment cannot check at all — and
 * letting them arrive as a bare `valid: false` would read as an accusation.
 */
const UNCHECKABLE: Record<string, string> = {
  legacy_hmac:
    "This receipt was sealed with the old symmetric key, before signing moved to Ed25519. That is not evidence of tampering — it cannot be publicly verified either way. Re-run the assay for a receipt anyone can check.",
  unknown_algorithm:
    "This receipt names a signature algorithm this deployment does not implement. That is not evidence of tampering; nothing was checked.",
};

/**
 * An encoding accident wearing a forgery's reason code.
 *
 * A receipt carries the punctuation Yuzu writes, em dashes included. Parse it
 * and re-serialise it and the signature still checks — verified against Python
 * in both ASCII-escaped and UTF-8 modes, with emoji, RTL text and floats. What
 * does break it is a consumer that decodes the bytes with the wrong codec,
 * because every character it could not represent arrives as U+FFFD and the
 * receipt is genuinely, if accidentally, altered.
 *
 * The signature cannot tell that apart from an edit, and should not pretend to.
 * But a replacement character is not something our signer ever emits, so its
 * presence is worth naming: it turns a bare accusation into the one sentence
 * that actually fixes the caller's problem.
 */
function mangled(candidate: unknown): string | undefined {
  let serialised: string;
  try {
    serialised = JSON.stringify(candidate) ?? "";
  } catch {
    return undefined;
  }
  // Written as an escape on purpose: a literal replacement character in this
  // file would be the first casualty of the very mistake it detects.
  if (!serialised.includes(String.fromCharCode(0xfffd))) return undefined;
  return (
    "This receipt contains U+FFFD replacement characters, which nothing here ever writes. " +
    "It was almost certainly decoded with the wrong character set somewhere between us and you — " +
    "read and write it as UTF-8, or hand us the bytes you were given. The signature covers the " +
    "canonical JSON of the parsed receipt, so re-serialising it is safe; re-encoding it is not."
  );
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ valid: false, reason: "unparseable_body" }, 400);
  }

  const candidate = (body as { receipt?: unknown })?.receipt ?? body;
  const result = verify(candidate);

  if (!result.valid) {
    const note = UNCHECKABLE[result.reason] ?? mangled(candidate);
    return json({ valid: false, reason: result.reason, ...(note !== undefined ? { note } : {}) }, 200);
  }

  return json({
    valid: true,
    expired: result.expired,
    receiptId: result.receipt.receiptId,
    issuedAt: result.receipt.issuedAt,
    vendor: result.receipt.report.vendor,
    verdict: result.receipt.report.verdict,
    score: result.receipt.report.score,
    decisions: result.receipt.decisions.length,
    signedBy: result.receipt.signature.publicKeyId,
  });
}

/**
 * A receipt id nobody can fetch is a citation to a book with no library.
 *
 * Two agents who had paid to check us were blocked by the same gap. Ground:
 * "your /api/verify wants the receipt body, not its id." Veritas, asked to
 * verify our own published correction, returned credibility 25/100 and
 * "cannot determine -- no URL, room events are not in the public corpus."
 * Both were right: we were publishing receipt ids into a chat room with no
 * address anyone could dereference.
 *
 * `?d=` carries the whole receipt, so this answers without a database and
 * without depending on any state the issuer could later change.
 */
export async function GET(request: Request): Promise<Response> {
  const packed = new URL(request.url).searchParams.get("d");

  if (packed !== null) {
    const receipt = unpackReceipt(packed);
    if (receipt === undefined) {
      return json(
        {
          error: "unreadable",
          message:
            "That is not a receipt this deployment can read. Unreadable is not the same as invalid: nothing was checked, " +
            "and no claim is being made about whoever gave it to you.",
        },
        400,
      );
    }

    const outcome = verify(receipt);
    const key = `${new URL(request.url).origin}/api/pubkey`;
    const note =
      "The receipt travelled inside the link, so this answer does not depend on any record Yuzu keeps. " +
      "Run the same check offline against the published key rather than taking this endpoint's word for it.";

    if (!outcome.valid) {
      const uncheckable = UNCHECKABLE[outcome.reason] ?? mangled(receipt);
      return json({
        valid: false,
        reason: outcome.reason,
        ...(uncheckable !== undefined ? { uncheckable } : {}),
        receipt,
        key,
        note,
      });
    }

    return json({
      valid: true,
      expired: outcome.expired,
      receiptId: outcome.receipt.receiptId,
      vendor: outcome.receipt.report.vendor,
      verdict: outcome.receipt.report.verdict,
      score: outcome.receipt.report.score,
      // The whole point for a verifier that was handed only an id: the text
      // this verdict was computed over, fingerprinted, inside the signature.
      source: outcome.receipt.report.source,
      signedBy: outcome.receipt.signature.publicKeyId,
      receipt,
      key,
      note,
    });
  }

  return json({
    service: "verify",
    method: "POST, or GET with ?d=<packed receipt> for a link anyone can dereference",
    price: "Free, always.",
    body: "A Touchstone receipt, or {\"receipt\": {...}}",
    returns: "Whether the signature still matches the contents.",
    // The same document /api/pubkey serves. Inlined so that a reader who found
    // this endpoint first never has to be told where the key lives.
    key: publicKeyDocument(),
  });
}
