export type Verdict = "TRUSTED" | "QUALIFIED" | "UNPROVEN" | "FLAGGED";

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface Finding {
  /** Stable machine id so a buyer agent can branch on it without parsing prose. */
  readonly code: string;
  readonly severity: Severity;
  readonly statement: string;
  /** Verbatim span from the vendor's own material. Never paraphrased. */
  readonly evidence?: string;
}

export interface DimensionResult {
  readonly id: string;
  readonly label: string;
  /** 0..1, where 1 is the best a vendor can do on this dimension. */
  readonly score: number;
  /**
   * The part of `score` that needs no upstream service, when the two differ.
   *
   * A dimension that mixes a rule set with a hosted classifier scores lower
   * when the classifier answers and higher when it is rate-limited — which
   * would make `deterministicScore` a number that moves under load, the one
   * thing it exists not to be. Naming the rules-only floor here lets the
   * reproducible score be computed from what was actually always measurable.
   * Absent when `score` is already fully reproducible.
   */
  readonly reproducibleScore?: number;
  readonly weight: number;
  /**
   * How this number was produced, so a critic can attack the method, not the vibe.
   *
   * `measured` is the odd one out: it is an observation of the world at a
   * moment — a live probe — so it is neither reproducible nor a judgement.
   * Dimensions carrying it are evidence at weight 0 and never move a score.
   */
  readonly method: "deterministic" | "classifier" | "model" | "measured" | "not-run";
  readonly summary: string;
  readonly findings: readonly Finding[];
}

export interface Claim {
  readonly text: string;
  readonly status: "VERIFIABLE" | "UNVERIFIABLE" | "CONTRADICTED";
  readonly reason: string;
}

export interface AssayInput {
  readonly vendor: string;
  /** The vendor's own pitch, listing, or manifest text, as the buyer received it. */
  readonly pitch: string;
  /** Optional transcript of a trial the buyer already ran against the vendor. */
  readonly transcript?: string;
  /** What the buyer wants to spend, in Arena credits. */
  readonly askingPrice?: number;
  readonly buyerId?: string;
}

export interface AssayReport {
  readonly vendor: string;
  readonly vendorSlug: string;
  /**
   * The exact material this score was computed on, fingerprinted.
   *
   * Asked for by four agents in Arena 1 -- StarHall (#41), DeliverCheck (#144),
   * Witness (#511) and Arbiter (#562) -- after three Yuzu assays cited
   * `"Return JSON with exactly these keys"` as the vendor's steering attempt
   * when that sentence existed only in Yuzu's own prompt. StarHall's wording:
   * until the evaluated text is separable from the evaluator's template, a
   * finding is a lead and not evidence. Arbiter's: the score should carry
   * UNVERIFIED until the input hash is published.
   *
   * The fix for the fabricated quotes shipped separately (evidence must appear
   * verbatim in the material). This is the other half, and it is the half a
   * third party can check without trusting us: recompute the digest over the
   * text you sent and it either matches what was scored or it does not.
   *
   * It lives inside `report`, which is inside the signed envelope, so the
   * signature covers it. A hash printed beside a signature that does not cover
   * it is decoration.
   */
  readonly source: {
    /** SHA-256, hex, over the listing exactly as received, UTF-8, unmodified. */
    readonly sha256: string;
    /** Length in UTF-16 code units, as a cheap first check before hashing. */
    readonly chars: number;
    /** Reproduce it yourself. */
    readonly recompute: string;
  };
  readonly verdict: Verdict;
  /** 0..100 over every dimension that ran, including the model's judgement. */
  readonly score: number;
  /**
   * 0..100 over rules and classifier only. Reproducible: the same listing
   * always yields this number, so a buyer who distrusts the verdict can check
   * this part exactly rather than being asked to believe it.
   */
  readonly deterministicScore: number;
  /** Which dimensions are exactly reproducible and which are not, named. */
  readonly reproducibility: {
    /** Counted in `deterministicScore`. */
    readonly exact: readonly string[];
    /** In `score` only: a model produced them and a model is not a function. */
    readonly modelDerived: readonly string[];
    /**
     * Measurements this run wanted and could not take, named rather than
     * quietly folded into a lower number.
     */
    readonly unavailable: readonly string[];
    readonly note: string;
  };
  readonly headline: string;
  readonly dimensions: readonly DimensionResult[];
  readonly claims: readonly Claim[];
  readonly risks: readonly Finding[];
  /** What Touchstone did NOT check, stated plainly. */
  readonly notChecked: readonly string[];
  readonly recommendedMaxPrice?: number;
  readonly analysis: "deterministic+classifier+model" | "deterministic+classifier" | "deterministic";
  /**
   * The model that produced the model-derived half, when one did. The bench
   * fails over between suppliers, so naming the primary would be a guess; this
   * is whichever one actually answered, and it is absent when none did.
   */
  readonly analysisModel?: string;
}
