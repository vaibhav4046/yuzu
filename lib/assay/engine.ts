import { createHash, randomUUID } from "node:crypto";
import type { AssayInput, AssayReport, DimensionResult, Finding } from "./types";
import { allFindings, deterministicScore, rankedRisks, recommendedMaxPrice, verdictFor, weightedScore } from "./score";
import { capByExaminable } from "./dimensions";
import { sign, type AutoDecisionTrace, type DecisionTrace, type Receipt } from "./receipt";
import { llmAvailable } from "./llm";
import type { AnalystResult } from "./analyst";
import { ASSAY_NAMESPACE, PURPOSES, slug } from "../sharedos/identity";
import { mintAutoDecidedGrant, mintOrderGrant } from "../sharedos/grants";
import { buildContext, callTool, toolCatalogue, traceFor } from "../sharedos/host";
import { depositGrant, withdrawGrant } from "../sharedos/authority";
import { closeOrder, openOrder } from "../sharedos/orders";
import { requestEscalation, type Escalation } from "../sharedos/escalation";
import { decideFromPrecedent } from "../sharedos/precedent";
import { askPayload, probeQuestion, seedPrecedents } from "../sharedos/precedent-seed";
import type { JsonObject } from "@aicoo/sharedos";

const RECEIPT_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * The matcher behind every auto-decision this engine makes, named and versioned.
 *
 * R4 wants a class handle rather than a per-request one: a matcher will be
 * improved, some improvement will be wrong, and the difference between that
 * being an incident and being a rollback is whether an operator can select
 * everything one generation produced and revoke it in a single action.
 */
const PROBE_MATCHER = "touchstone.probe.exact-question.v1";

export interface AssayOptions {
  /** A live endpoint the buyer wants probed. Never covered by an order grant. */
  readonly probeEndpoint?: string;
  readonly traceId?: string;
  /**
   * Keep the rules and the classifier; skip the model claim analysis.
   *
   * The broker assays every bidder before pricing, and at that moment the only
   * question is whether a listing trips a floor — steering, a request for
   * credentials — and those are decided deterministically. Running the full
   * claim-by-claim analysis on each bidder spends model budget where it changes
   * no decision, and on a rate-limited upstream it spends it in a burst that
   * then fails the calls which do matter. The first live run bought nothing for
   * exactly that reason.
   */
  readonly fast?: boolean;
  /**
   * Wake a person when the record cannot answer. Off unless a caller says so.
   *
   * `sharedos.escalate` puts a bridge into `escalation_pending`, where it stops
   * answering until somebody resolves it. That is correct behaviour and a
   * losing move in a room that forbids a human in the loop for two hours, so
   * the path stays here fully working behind a flag that is off during a run:
   * what the record cannot answer is named in the receipt and left for after.
   */
  readonly allowHumanEscalation?: boolean;
}

export interface AssayOutcome {
  readonly receipt: Receipt;
  readonly escalation?: Escalation;
  readonly elapsedMs: number;
}

export async function assay(input: AssayInput, options: AssayOptions = {}): Promise<AssayOutcome> {
  const started = Date.now();
  const orderId = `ord_${randomUUID().slice(0, 8)}`;
  const traceId = options.traceId ?? randomUUID();
  const vendorSlug = slug(input.vendor);

  /**
   * Fingerprint the material before anything reads it.
   *
   * Taken here, at the top, over `input.pitch` exactly as it arrived -- before
   * any fencing, truncation or prompt assembly -- because a digest taken after
   * the evaluator has touched the text would fingerprint the evaluator's
   * version and reproduce the very confusion this is meant to settle.
   */
  const source = {
    sha256: createHash("sha256").update(input.pitch, "utf8").digest("hex"),
    chars: input.pitch.length,
    recompute:
      "sha256 of the listing exactly as you sent it, UTF-8, no trailing newline: " +
      "node -e 'console.log(require(\"crypto\").createHash(\"sha256\").update(require(\"fs\").readFileSync(0),\"utf8\").digest(\"hex\"))' < listing.txt",
  } as const;
  const buyerId =
    typeof input.buyerId === "string" && input.buyerId.trim().length > 0
      ? input.buyerId.trim()
      : "anonymous-buyer";

  // The owner's answers go on the record before the run can consult them. It
  // is a fixed table, and a no-op after the first assay a given buyer runs.
  await seedPrecedents(buyerId);

  openOrder({ orderId, buyerId, purpose: PURPOSES.assay, vendors: [input] });

  const grant = mintOrderGrant({
    orderId,
    buyerId,
    purpose: PURPOSES.assay,
    vendorSlugs: [vendorSlug],
    maxUses: 12,
    ttlMs: 5 * 60_000,
    now: new Date(),
  });

  depositGrant(grant);
  const context = buildContext({ buyerId, purpose: PURPOSES.assay, traceId });
  // Computed here, with the order grant live: the hash then names the surface
  // the assay could actually reach, and the signature covers it.
  const catalogue = await toolCatalogue(context);
  const args = { orderId, vendor: vendorSlug };
  const claimsPath = ["vendors", vendorSlug, "claims"];

  try {
    // Reading the material is itself authorised. If this is denied there is
    // nothing to assay and the receipt says so rather than inventing a score.
    const readOutcome = await callTool(context, "assay.read_claims", args, { path: claimsPath, action: "read" });
    if (readOutcome.denied !== undefined || readOutcome.result?.status === "denied") {
      const reasonCode = readOutcome.denied?.reasonCode ?? (readOutcome.result?.status === "denied" ? readOutcome.result.error.code : "access_denied");
      const report: AssayReport = {
        vendor: input.vendor,
        vendorSlug,
        source,
        verdict: "UNPROVEN",
        score: 0,
        deterministicScore: 0,
        reproducibility: { exact: [], modelDerived: [], unavailable: [`read_claims: denied (${reasonCode})`], note: "Access denied by kernel." },
        headline: `Assay refused: material read denied by kernel policy (${reasonCode}).`,
        dimensions: [],
        claims: [],
        risks: [{ code: "ACCESS_DENIED", severity: "high", statement: `Read access to ${vendorSlug} claims was denied by kernel policy (${reasonCode}).` }],
        notChecked: [`Material reading refused by authorizer (${reasonCode}). No analysis performed.`],
        analysis: "deterministic",
      };
      const receipt = sign({
        version: "touchstone.receipt.v1",
        receiptId: `rcp_${randomUUID().slice(0, 12)}`,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + RECEIPT_TTL_MS).toISOString(),
        issuer: "touchstone",
        buyerId: input.buyerId ?? "anonymous-buyer",
        purpose: PURPOSES.assay,
        traceId,
        report,
        decisions: traceFor(traceId),
        escalations: [],
        toolCatalogHash: catalogue.hash,
      });
      return { receipt, elapsedMs: Date.now() - started };
    }

    const [steeringCall, staticCall, analystCall] = await Promise.all([
      callTool(context, "assay.steering_scan", args, { path: claimsPath, action: "classify" }),
      callTool(context, "assay.static_checks", args, { path: claimsPath, action: "analyze" }),
      options.fast === true
        ? Promise.resolve({ result: undefined })
        : callTool(context, "assay.claim_analysis", args, { path: claimsPath, action: "analyze" }),
    ]);

    const steeringDimension = outputOf<DimensionResult>(steeringCall.result);
    const staticDimensions = outputOf<DimensionResult[]>(staticCall.result) ?? [];
    const analyst = outputOf<AnalystResult>(analystCall.result);

    // A dimension that did not run is not a dimension that passed. Name it and
    // the reason, so a low score is never mistaken for a clean sheet.
    const unrun: string[] = [
      ["steering scan", steeringCall.result] as const,
      ["static checks", staticCall.result] as const,
      ["claim analysis", analystCall.result] as const,
    ].flatMap(([label, result]) =>
      result === undefined || result.status === "succeeded"
        ? []
        : [`${label}: did not run (${result.status === "denied" || result.status === "failed" ? result.error.code : "unknown"}).`],
    );

    const dimensions: DimensionResult[] = [
      ...staticDimensions,
      ...(steeringDimension ? [steeringDimension] : []),
      ...(analyst ? [analyst.dimension] : []),
    ];

    // The probe is attempted, not skipped. The denial is the finding.
    let escalation: Escalation | undefined;
    const autoDecisions: AutoDecisionTrace[] = [];
    const notChecked: string[] = [...unrun];
    if (options.probeEndpoint !== undefined) {
      const probePath = ["vendors", vendorSlug, "probe"];
      const probeArgs = { ...args, endpoint: options.probeEndpoint };
      const requirement = { path: probePath, action: "probe" };
      const probe = await callTool(context, "assay.probe_vendor", probeArgs, requirement);

      const firstProbe = probeDimension(options.probeEndpoint, probe.result);
      if (firstProbe !== undefined) dimensions.push(firstProbe);

      if (probe.denied !== undefined) {
        // Authority the order grant does not carry. Ask the record before
        // asking a person: the owner answered this question in front of the
        // room, and inside the room there is nobody left to ask.
        const decided = await decideFromPrecedent(context, askPayload(probeQuestion(vendorSlug)), PROBE_MATCHER);
        autoDecisions.push({
          matcher: decided.asked,
          resource: `${ASSAY_NAMESPACE}/${probePath.join("/")}`,
          action: "probe",
          admitted: decided.admitted,
          allowed: decided.allowed,
          match: decided.match,
          narrowed: decided.narrowed,
          citedRequestIds: decided.citedRequestIds,
          reason: decided.reason,
        });

        if (
          decided.admitted &&
          decided.allowed &&
          decided.requestId !== undefined &&
          decided.capabilities !== undefined &&
          decided.constraints !== undefined
        ) {
          // The order grant is never widened. The record issues a second and
          // strictly smaller one, exactly as an approved escalation would.
          const grant = mintAutoDecidedGrant({
            requestId: decided.requestId,
            buyerId,
            capabilities: decided.capabilities,
            constraints: decided.constraints,
            metadata: (decided.metadata ?? {}) as JsonObject,
            now: new Date(),
          });
          depositGrant(grant);
          try {
            // Probing is its own intent, and the envelope the record handed
            // back says so. A grant minted for it authorises nothing under the
            // assay purpose, so the retry states the purpose it is for.
            const probeContext = buildContext({ buyerId, purpose: PURPOSES.probe, traceId });
            const retried = await callTool(probeContext, "assay.probe_vendor", probeArgs, requirement);
            const retriedProbe = probeDimension(options.probeEndpoint, retried.result);
            if (retriedProbe !== undefined) dimensions.push(retriedProbe);
            if (retried.denied !== undefined) {
              notChecked.push(
                `Live behaviour of ${options.probeEndpoint}: not probed. The owner's record allowed it, but the call was still refused (${retried.denied.reasonCode}).`,
              );
            }
          } finally {
            // The grant covered one probe. It does not outlive it.
            withdrawGrant(grant.id);
          }
        } else if (options.allowHumanEscalation === true) {
          escalation = await requestEscalation({
            buyerId,
            resourcePath: probePath,
            action: "probe",
            reason: `Buyer asked for a live probe of ${options.probeEndpoint}. An order grant does not carry authority to reach a third party.`,
            context,
          });
          notChecked.push(
            `Live behaviour of ${options.probeEndpoint}: not probed. Reaching a third party needs an approved escalation (${escalation.id}), and this order grant does not carry it.`,
          );
        } else {
          notChecked.push(
            `Live behaviour of ${options.probeEndpoint}: not probed. ${
              decided.admitted
                ? "The owner refused this question before the Arena opened."
                : `The owner's record does not answer this question (${decided.reason ?? "unknown"}).`
            } Nobody is woken mid-run to answer it.`,
          );
        }
      }
    } else {
      notChecked.push("Live behaviour: not probed. No endpoint was supplied and no escalation was requested.");
    }

    if (input.transcript === undefined) {
      notChecked.push("Delivered work: no trial transcript was supplied, so only the vendor's claims were examined.");
    }
    if (!llmAvailable() || analyst?.ok !== true) {
      notChecked.push("Claim-by-claim model analysis: unavailable on this run. Deterministic and classifier findings stand alone.");
    }

    // Nothing is scored until the listing has been asked how much of itself it
    // actually offered up. Four of these dimensions score by finding no fault,
    // and an empty listing gives them no fault to find — which is how a blank
    // pitch outscored a real vendor before this line existed.
    const graded = capByExaminable(dimensions, input.pitch);

    const findings = allFindings(graded);
    const score = weightedScore(graded);
    const { verdict, reason } = verdictFor(score, findings);
    const risks: Finding[] = [...rankedRisks(findings), ...(analyst?.risks ?? [])].slice(0, 10);

    const modelDerived = graded.filter((d) => d.method === "model" && d.weight > 0).map((d) => d.label);
    const exact = graded
      .filter((d) => d.method !== "model" && d.method !== "measured" && d.method !== "not-run" && d.weight > 0)
      .map((d) => d.label);

    // Named, not averaged in. A measurement that could not be taken is the one
    // thing a reproducible number must not quietly absorb.
    const unavailable: string[] = [
      // Two disjoint ways to go missing: the tool call was refused, so there is
      // no dimension at all; or it ran and the thing it needed did not answer.
      ...unrun,
      ...graded.filter((d) => d.method === "not-run").map((d) => `${d.label}: did not run`),
      ...(steeringDimension !== undefined && steeringDimension.method !== "classifier"
        ? ["Steering resistance: injection classifier unavailable, so deterministicScore counts its rule set alone"]
        : []),
      // Only when no dimension is there to say it: an analyst that ran and
      // failed already appears above as `not-run`, and saying it twice reads
      // like two separate gaps.
      ...(analyst === undefined ? ["Claim analysis: not run on this call"] : []),
    ];

    const report: AssayReport = {
      vendor: input.vendor,
      vendorSlug,
      source,
      verdict,
      score,
      deterministicScore: deterministicScore(graded),
      reproducibility: {
        exact,
        modelDerived,
        unavailable,
        note:
          "deterministicScore covers the published rule sets only, so it is identical on every run of the same listing — including a run where the injection classifier or the model was rate-limited. score also includes whatever else answered this time, which is why the two numbers differ. The rule-set floors — steering and credential requests — are deterministic and fire whether or not a model answered. A model can add a floor and can never lift one: a critical analyst finding flags the listing too, but no outage, rate limit or refusal can turn a FLAGGED listing into a TRUSTED one.",
      },
      headline: reason ?? analyst?.headline ?? defaultHeadline(verdict, score, graded),
      dimensions: graded,
      claims: analyst?.claims ?? [],
      risks,
      notChecked,
      recommendedMaxPrice: recommendedMaxPrice(input.askingPrice, score, verdict),
      analysisModel: analyst?.model,
      analysis:
        analyst?.ok === true
          ? "deterministic+classifier+model"
          : steeringDimension?.method === "classifier"
            ? "deterministic+classifier"
            : "deterministic",
    };

    const decisions: readonly DecisionTrace[] = traceFor(traceId);
    const now = new Date();
    const receipt = sign({
      version: "touchstone.receipt.v1",
      receiptId: `rcp_${randomUUID().slice(0, 12)}`,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + RECEIPT_TTL_MS).toISOString(),
      issuer: "touchstone",
      buyerId,
      purpose: PURPOSES.assay,
      traceId,
      report,
      decisions,
      autoDecisions,
      toolCatalogHash: catalogue.hash,
      escalations:
        escalation === undefined
          ? []
          : [
              {
                id: escalation.id,
                resource: `assay/${escalation.resourcePath.join("/")}`,
                action: escalation.action,
                state: escalation.state,
              },
            ],
    });

    return { receipt, escalation, elapsedMs: Date.now() - started };
  } finally {
    closeOrder(orderId);
    withdrawGrant(grant.id);
  }
}

interface ProbeOutput {
  readonly reachable: boolean;
  readonly status?: number;
  readonly latencyMs?: number;
  readonly contentType?: string | null;
  readonly error?: string;
}

/**
 * A probe that worked is evidence, and evidence belongs in the report.
 *
 * The probe result used to be read only for whether it was denied, so the one
 * path in this system that actually touches the vendor left no trace when it
 * succeeded — a buyer who paid for a live check got a receipt that never
 * mentioned it. It lands in `dimensions` at weight 0 on purpose: probing needs
 * authority the assay itself does not carry, and a listing must not score
 * better for having been reachable than an identical listing nobody probed.
 */
export function probeDimension(
  endpoint: string,
  result: { status: string; output?: unknown; error?: { code: string; message: string } } | undefined,
): DimensionResult | undefined {
  // A probe the host refused is not a probe nobody asked for. The tool checks
  // the endpoint against the seller the capability path names before it calls
  // anything, and a receipt that omitted that refusal would read exactly like a
  // receipt for a run where no probe was ever requested.
  if (result?.status === "failed" && result.error !== undefined) {
    return {
      id: "probe",
      label: "Live endpoint",
      score: 0,
      weight: 0,
      method: "not-run",
      summary: `${endpoint} was never called. ${result.error.message} (${result.error.code})`,
      findings: [
        {
          code: "PROBE_REFUSED",
          severity: "low",
          statement: `The probe of ${endpoint} was refused before any request left this host: ${result.error.message} (${result.error.code}). Nothing about the vendor was learned or claimed.`,
        },
      ],
    };
  }

  const output = outputOf<ProbeOutput>(result);
  if (output === undefined) return undefined;

  const latency = output.latencyMs === undefined ? "unknown" : `${output.latencyMs}ms`;
  if (!output.reachable) {
    return {
      id: "probe",
      label: "Live endpoint",
      score: 0,
      weight: 0,
      method: "measured",
      summary: `${endpoint} did not answer (${output.error ?? "unknown"}) after ${latency}.`,
      findings: [
        {
          code: "PROBE_UNREACHABLE",
          severity: "medium",
          statement: `The endpoint the vendor gave, ${endpoint}, did not answer when called (${output.error ?? "unknown"}).`,
        },
      ],
    };
  }

  const contentType = output.contentType ?? undefined;
  return {
    id: "probe",
    label: "Live endpoint",
    score: output.status !== undefined && output.status >= 500 ? 0 : 1,
    weight: 0,
    method: "measured",
    summary: `${endpoint} answered ${output.status ?? "?"} in ${latency}${contentType === undefined ? "" : ` (${contentType})`}.`,
    findings:
      output.status !== undefined && output.status >= 500
        ? [
            {
              code: "PROBE_SERVER_ERROR",
              severity: "medium",
              statement: `${endpoint} answered ${output.status}. The endpoint is reachable but was failing when checked.`,
            },
          ]
        : [],
  };
}

function outputOf<T>(result: { status: string; output?: unknown } | undefined): T | undefined {
  if (result === undefined || result.status !== "succeeded") return undefined;
  return result.output as T;
}

function defaultHeadline(verdict: string, score: number, dimensions: readonly DimensionResult[]): string {
  const weakest = [...dimensions]
    .filter((dimension) => dimension.weight > 0)
    .sort((left, right) => left.score - right.score)[0];
  const tail = weakest === undefined ? "" : ` Weakest dimension: ${weakest.label.toLowerCase()}.`;
  return `${verdict} at ${score.toFixed(1)}/100 on published weights.${tail}`;
}
