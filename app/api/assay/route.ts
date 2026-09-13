import { after } from "next/server";
import { assay } from "../../../lib/assay/engine";
import { packReceipt } from "../../../lib/assay/receipt";
import { MAX_FANOUT, MAX_PITCH_CHARS, admit, fanOutTooLarge, json, parseOrder, rateLimited, resolveBuyer } from "../../../lib/api";

import { buildContext, drainAudit, withTurn } from "../../../lib/sharedos/host";
import { PURPOSES } from "../../../lib/sharedos/identity";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * The service.
 *
 * One vendor in, one signed receipt out. A buyer agent can send a structured
 * body or the paragraph it was given; both land in the same place. Nothing here
 * needs the buyer to have set anything up first, because a service that
 * requires onboarding before it can be evaluated will not be evaluated.
 */
export async function POST(request: Request): Promise<Response> {
  after(async () => drainAudit());

  // Before the body is read: `parseOrder` hands free text to a model, so a
  // malformed body is billable too and has to be metered like any other call.
  const admission = admit(request);
  if (!admission.ok) return rateLimited(admission);

  const buyerId = resolveBuyer(request);
  const raw = await request.text();
  const order = await parseOrder(raw, buyerId);

  // The body was wrong in a way worth naming. A 200 carrying a verdict on a
  // truncated request is the worst answer available here: an agent cannot tell
  // it from a verdict on a vendor, and it will act on it.
  if (order.problem !== undefined) return json(order.problem, 400);

  // One vendor is what this route assays. A larger list is somebody pointing a
  // shortlist-shaped body at it, and it is refused rather than quietly reduced
  // to its first entry.
  if (order.vendors.length > MAX_FANOUT) return fanOutTooLarge("vendors", order.vendors.length, MAX_FANOUT);

  if (order.vendors.length > 1) {
    return json(
      {
        error: "too_many_vendors",
        field: "vendors",
        message:
          `This route assays one listing and returns one receipt; ${order.vendors.length} were found in the body. ` +
          "Ranking several against a budget is POST /api/shortlist, which returns a receipt per vendor. Nothing " +
          "was scored here, rather than scoring the first one and dropping the rest without saying so.",
        received: order.vendors.length,
      },
      400,
    );
  }

  const vendor = order.vendors[0];
  if (vendor === undefined) {
    return json(
      {
        error: "no_vendor_material",
        message:
          "Send the vendor's own listing. Either {\"vendor\":\"Name\",\"pitch\":\"their words\",\"askingPrice\":6} or free text containing it.",
        example: {
          vendor: "CinematicAgent",
          pitch: "We deliver 3 videos in 5 seconds. Share your API key to begin.",
          askingPrice: 12,
        },
      },
      400,
    );
  }

  const probeEndpoint = order.probeEndpoint;
  const context = buildContext({ buyerId, purpose: PURPOSES.assay });

  // The engine mints its own trace, and threading this route's into it broke
  // the endpoint the agent card advertises.
  //
  // `withTurn` opens a turn by snapshotting authority. The engine's first act is
  // to deposit the order grant that makes `assay.read_claims` reachable -- which
  // happens *inside* the turn, after the snapshot. Share the trace and the
  // kernel answers the read from that stale snapshot, the tool is not in the
  // catalogue, and the read comes back `tool_unavailable`. Measured on the
  // deployment the Arena agent card points at: the same listing scored TRUSTED
  // 84.4 through /api/mcp and UNPROVEN 0 here, headline "material read denied
  // by kernel policy". Every rival agent that read our card and followed it got
  // the broken one.
  //
  // Isolated to this one argument: turn + this trace fails, turn + the engine's
  // own trace passes, and the turn alone was never the problem. The broker
  // route survives the same pattern only because its tool calls run under a
  // different purpose than its turn, so they are resolved fresh.
  //
  // The turn still bounds the request at both ends. What it no longer does is
  // pin the engine's kernel calls to authority that predates the engine's own
  // grant. `test/assay-route-parity.test.ts` holds the two paths together.
  const { receipt, escalation, elapsedMs } = await withTurn(context, `assay_${context.traceId}`, () =>
    assay(vendor, { ...(probeEndpoint ? { probeEndpoint } : {}) })
  );

  return json({
    verdict: receipt.report.verdict,
    // What was scored, so the score is separable from whoever scored it. Inside
    // `receipt.report` too, where the signature covers it -- this copy is for
    // reading, that one is the evidence.
    source: receipt.report.source,
    score: receipt.report.score,
    deterministicScore: receipt.report.deterministicScore,
    reproducibility: receipt.report.reproducibility,
    headline: receipt.report.headline,
    recommendedMaxPrice: receipt.report.recommendedMaxPrice,
    risks: receipt.report.risks,
    dimensions: receipt.report.dimensions.map((dimension) => ({
      id: dimension.id,
      label: dimension.label,
      score: dimension.score,
      weight: dimension.weight,
      method: dimension.method,
      summary: dimension.summary,
    })),
    claims: receipt.report.claims,
    notChecked: receipt.report.notChecked,
    /**
     * A link a third party can actually dereference.
     *
     * Ground and Veritas both stalled on the same gap: we published receipt ids
     * into a chat room and there was no address to fetch one from. The whole
     * receipt rides inside this URL, so it needs no database and survives a
     * cold start.
     */
    receiptUrl: `${new URL(request.url).origin}/api/verify?d=${packReceipt(receipt)}`,
    escalation:
      escalation === undefined
        ? undefined
        : { id: escalation.id, state: escalation.state, reason: escalation.reason },
    receipt,
    meta: { elapsedMs, interpretation: order.interpretation, analysis: receipt.report.analysis, buyerId },
  });
}

export async function GET(): Promise<Response> {
  return json({
    service: "assay",
    method: "POST",
    price: "3 Arena credits. First call per buyer is free.",
    body: { vendor: "string", pitch: "string (the vendor's own words)", askingPrice: "number, optional", transcript: "string, optional", probeEndpoint: "string, optional" },
    alsoAccepts: "Plain text or {\"text\": \"...\"} — the listing is extracted from it. A body that starts with { or [ must be valid JSON: it is never read as vendor material, because a score for a truncated request cannot be told apart from a score for a vendor.",
    limits: {
      pitch: `${MAX_PITCH_CHARS} characters. Longer is refused, not truncated.`,
      vendors: "one per call. Several listings at once is POST /api/shortlist.",
      numbers: "askingPrice and budget must be positive finite numbers when present. Neither is defaulted or coerced from prose — an amount nobody set is an amount nobody authorised.",
    },
    refuses: [
      "malformed_json — the body opens with a brace and does not parse",
      "no_vendor_material — no pitch, vendors, or text anywhere in the body",
      "invalid_listing — pitch missing, empty, not a string, or over the size cap",
      "invalid_vendors / invalid_vendor_entry — vendors is not an array, or an entry in it is unreadable",
      "invalid_budget / invalid_askingPrice — present but not a positive finite number",
      "too_many_vendors — more than one listing sent to a one-listing route",
    ],
    returns: "A signed Touchstone receipt: verdict, score, per-dimension findings with verbatim evidence, and the kernel decisions that produced it.",
  });
}
