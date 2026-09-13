import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { AssayReport } from "./types";

/**
 * A receipt is portable evidence, not a database row.
 *
 * The whole report is signed and handed to the buyer. Anyone — the buyer, a
 * rival vendor, a judge — can verify it against the public endpoint without
 * Touchstone being online or trusted, and nothing about a past assay depends
 * on us still holding it. That is deliberate: an assay office whose findings
 * only exist inside the assay office is asking to be taken on faith.
 */

export interface DecisionTrace {
  readonly action: string;
  readonly resource: string;
  readonly outcome: "allowed" | "denied" | "escalated";
  readonly reasonCode: string;
  readonly grantId?: string;
  readonly ceilingRule?: string;
}

/**
 * Authority answered from the owner's own record instead of by waking a person.
 *
 * It sits beside `escalations` rather than inside them because it is the
 * opposite event. An escalation is a decision nobody has made yet; this is one
 * that was made before the room opened and merely read back — so filing them
 * together would count a machine answer as a request for help.
 */
export interface AutoDecisionTrace {
  /** The matcher that produced it. R4's handle: the thing an operator revokes. */
  readonly matcher: string;
  readonly resource: string;
  readonly action: string;
  /** Whether the record could answer at all, separate from what it answered. */
  readonly admitted: boolean;
  readonly allowed: boolean;
  /** Whether the cited evidence was the identical question, or merely a similar one. */
  readonly match?: string;
  /** True when resemblance carried it and the grant was bounded by the ask as well. */
  readonly narrowed?: boolean;
  readonly citedRequestIds: readonly string[];
  /** Why the record could not answer, when it could not. */
  readonly reason?: string;
}

export interface Receipt {
  readonly version: "touchstone.receipt.v1";
  readonly receiptId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly issuer: "touchstone";
  readonly buyerId: string;
  readonly purpose: string;
  readonly traceId: string;
  readonly report: AssayReport;
  /** Every authorization the kernel made while producing this report. */
  readonly decisions: readonly DecisionTrace[];
  readonly escalations: readonly { id: string; resource: string; action: string; state: string }[];
  /**
   * Authority the record answered, so a reader can audit what ran without a
   * person. Absent on a receipt from a path that never asked for any.
   */
  readonly autoDecisions?: readonly AutoDecisionTrace[];
  /**
   * The hash of the tool surface this record actually ran against, from the
   * kernel's own catalogue rather than a list we keep. It is computed while
   * the order grant is live, so it names the tools that were reachable during
   * the work -- not the empty set an idle process would report -- and being
   * inside the signature means the surface cannot be revised afterwards
   * either. Absent on a receipt from a path that never asked the kernel.
   */
  readonly toolCatalogHash?: string;
  /**
   * Ed25519 over the canonical bytes of everything above, base64.
   *
   * `alg` and `publicKeyId` sit inside the block they describe and are
   * therefore not themselves covered by the signature. That is safe only
   * because nothing trusts them: `verify` dispatches on `alg` and then checks
   * against the key *this deployment* publishes, never against a key the
   * receipt names. Relabelling a receipt changes which check runs, and every
   * check still has to pass.
   */
  readonly signature: { alg: "ed25519"; value: string; publicKeyId: string };
}

/**
 * The shared secret. It seals escalation tickets, and nothing else.
 *
 * Receipts used to be signed with this too, and that made "anyone can check a
 * receipt" false: an HMAC is a claim only its holder can check, so every
 * dispute ended at our own endpoint saying trust me. Receipts moved to Ed25519
 * below. Tickets did not, and the difference is the point.
 *
 * A receipt is *evidence*: publishing the key that checks it costs nothing,
 * because the public half cannot mint one. An escalation ticket is *authority*
 * — `decideEscalation` mints a capability grant from the path and action the
 * ticket names, so anyone who can produce a valid ticket can produce a grant.
 * Handing the world a key that verifies tickets, in a system where the same
 * parties would like to write them, is the whole vulnerability. Symmetric is
 * correct here: the only party that should be able to check a ticket is the
 * party that issued it.
 *
 * This repository is public, so a committed fallback is not a fallback — it is
 * the key, published, for anyone who deploys without setting the real one. In
 * production a missing key is therefore fatal at the point of use rather than
 * silently substituted. Locally it falls back to a key whose own name says it
 * is worthless, so tests and `npm run dev` still run.
 */
const DEV_KEY = "INSECURE-DEV-ONLY-touchstone-key-do-not-deploy";

export function signingKey(): string {
  const configured = process.env.TOUCHSTONE_SIGNING_KEY;
  if (configured !== undefined && configured.length > 0) return configured;
  if (process.env.NODE_ENV === "production" || process.env.VERCEL === "1") {
    throw new Error(
      "TOUCHSTONE_SIGNING_KEY is not set. Refusing to sign or verify with the public development key.",
    );
  }
  return DEV_KEY;
}

/**
 * Receipt keys: Ed25519. The private half lives here, the public half is served
 * to anyone who asks, and that is the only reason "anyone can check a receipt"
 * is a true sentence.
 *
 * `TOUCHSTONE_SIGNING_SECRET` is the 32-byte Ed25519 seed, base64. One line,
 * which is what an environment variable can actually hold, and the same thing
 * every other Ed25519 tool means by "the private key":
 *
 *   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
 *
 * Locally it is derived from a fixed label rather than generated, so the public
 * key is identical on every run and in every process: tests can pin it, and a
 * receipt written by `npm run dev` still verifies tomorrow. A freshly generated
 * dev key would be a different key every reload, and a receipt that stops
 * verifying is indistinguishable from a receipt someone edited. The label is
 * the warning — this key is published, in this file, in a public repository.
 */
const DEV_SEED_LABEL = "INSECURE-DEV-ONLY-touchstone-ed25519-do-not-deploy";

/** DER header of a PKCS8 Ed25519 private key. The 32-byte seed follows it. */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

interface Keypair {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  /** True when the committed development seed is in use. Published, loudly. */
  readonly development: boolean;
}

function keypair(): Keypair {
  const configured = process.env.TOUCHSTONE_SIGNING_SECRET;
  let seed: Buffer;
  let development: boolean;

  if (configured !== undefined && configured.length > 0) {
    seed = Buffer.from(configured, "base64");
    if (seed.length !== 32) {
      // base64 decoding is lenient enough to turn a pasted PEM, or a copied
      // half of one, into plausible bytes. Length is what catches the wrong
      // thing entirely, and it is worth catching loudly: the alternative is a
      // deployment that signs every receipt with a key nobody meant.
      throw new Error(
        `TOUCHSTONE_SIGNING_SECRET must be a base64-encoded 32-byte Ed25519 seed; it decoded to ${seed.length} bytes.`,
      );
    }
    development = false;
  } else {
    if (process.env.NODE_ENV === "production" || process.env.VERCEL === "1") {
      throw new Error(
        "TOUCHSTONE_SIGNING_SECRET is not set. Refusing to sign or verify with the public development keypair. " +
          "(Receipt signing moved from the HMAC TOUCHSTONE_SIGNING_KEY to Ed25519; TOUCHSTONE_SIGNING_KEY now seals escalation tickets only.)",
      );
    }
    seed = createHash("sha256").update(DEV_SEED_LABEL).digest();
    development = true;
  }

  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  return { privateKey, publicKey: createPublicKey(privateKey), development };
}

/** The bare 32 key bytes, without the SPKI wrapper. What non-Node tools want. */
function rawPublicKey(publicKey: KeyObject): Buffer {
  return publicKey.export({ format: "der", type: "spki" }).subarray(-32);
}

/** Names which key signed a receipt. A digest of the public half, so public. */
function keyId(publicKey: KeyObject): string {
  return createHash("sha256").update(rawPublicKey(publicKey)).digest("hex").slice(0, 16);
}

/**
 * What a stranger is handed so they never have to ask us anything again.
 *
 * Every field is derived from the public half; no branch in here can reach the
 * seed, and `test/pubkey.test.ts` asserts the served bytes contain neither the
 * seed nor the ticket secret. An endpoint whose entire job is to be copied is
 * the worst possible place for a leak.
 */
export interface PublicKeyDocument {
  readonly alg: "ed25519";
  readonly publicKeyId: string;
  /** SPKI DER, base64. Loads straight into `crypto.createPublicKey`. */
  readonly publicKey: string;
  /** The bare 32 key bytes, base64, for tools that want them raw. */
  readonly publicKeyRaw: string;
  readonly signatureEncoding: "base64";
  readonly signedBytes: string;
  /** True when this deployment is signing with the committed development key. */
  readonly development: boolean;
  readonly verify: string;
}

export function publicKeyDocument(): PublicKeyDocument {
  const { publicKey, development } = keypair();
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return {
    alg: "ed25519",
    publicKeyId: keyId(publicKey),
    publicKey: spki,
    publicKeyRaw: rawPublicKey(publicKey).toString("base64"),
    signatureEncoding: "base64",
    signedBytes:
      "Canonical JSON of the receipt with its `signature` member removed: object keys sorted at every depth, " +
      "arrays left in their order, `undefined` members dropped, UTF-8.",
    development,
    verify: VERIFY_SNIPPET.replace("<PUBLIC_KEY>", spki),
  };
}

/**
 * Runnable, offline, no dependencies, no network. Save it next to a receipt and
 * run it. It is deliberately the same handful of lines `verify` below runs — if
 * the snippet and the endpoint could disagree they would not be the same check,
 * and the endpoint would be back to being something you have to trust.
 */
const VERIFY_SNIPPET = [
  "// node check.cjs receipt.json   ->   true means the receipt is intact",
  'const { createPublicKey, verify } = require("node:crypto");',
  'const receipt = require(require("node:path").resolve(process.argv[2]));',
  "",
  "const canonical = (v) =>",
  '  v === null || typeof v !== "object" ? JSON.stringify(v) ?? "null"',
  '  : Array.isArray(v) ? "[" + v.map(canonical).join(",") + "]"',
  '  : "{" + Object.entries(v)',
  "      .filter(([, i]) => i !== undefined)",
  "      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))",
  '      .map(([k, i]) => JSON.stringify(k) + ":" + canonical(i))',
  '      .join(",") + "}";',
  "",
  "const { signature, ...unsigned } = receipt;",
  'const key = createPublicKey({ key: Buffer.from("<PUBLIC_KEY>", "base64"), format: "der", type: "spki" });',
  'console.log(verify(null, Buffer.from(canonical(unsigned)), key, Buffer.from(signature.value, "base64")));',
].join("\n");

/**
 * Canonical JSON: keys sorted at every depth, arrays left in order.
 *
 * The obvious version of this is `JSON.stringify(value, Object.keys(value).sort())`,
 * and it is wrong in a way that matters. An array second argument to
 * `JSON.stringify` is an allowlist applied at *every* level, so nested
 * properties whose names happen not to appear at the top level are dropped from
 * the output — and therefore from the signature. A receipt signed that way
 * verifies happily after someone rewrites its verdict. The test suite catches
 * exactly that; this walks the tree instead.
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof (value as { toJSON?: () => unknown }).toJSON === "function") {
    return canonical((value as { toJSON: () => unknown }).toJSON());
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

export function sign(receipt: Omit<Receipt, "signature">): Receipt {
  const { privateKey, publicKey } = keypair();
  const value = edSign(null, Buffer.from(canonical(receipt)), privateKey).toString("base64");
  return { ...receipt, signature: { alg: "ed25519", value, publicKeyId: keyId(publicKey) } };
}

/**
 * Sign anything, with the receipt key and the receipt canonicaliser.
 *
 * The Arena ledger needs to survive an instance dying, and this repository
 * deliberately has no database. The answer it already uses everywhere else is
 * the right one here too: make the record self-contained and sign it, so it is
 * durable in the hands of whoever holds it rather than in storage we do not
 * have. A spend record checks against the same public key and the same offline
 * script at /api/pubkey as any receipt, because it is the same signature over
 * the same canonical bytes.
 *
 * `kind` is inside the signed payload rather than beside it, so a record of one
 * sort cannot be presented as another.
 */
export interface Signed<T> {
  readonly kind: string;
  readonly payload: T;
  readonly signature: { readonly alg: "ed25519"; readonly value: string; readonly publicKeyId: string };
}

export function signPayload<T>(kind: string, payload: T): Signed<T> {
  const { privateKey, publicKey } = keypair();
  const value = edSign(null, Buffer.from(canonical({ kind, payload })), privateKey).toString("base64");
  return { kind, payload, signature: { alg: "ed25519", value, publicKeyId: keyId(publicKey) } };
}

/** True only when this is a record of the kind asked for and the signature holds. */
export function verifyPayload<T>(kind: string, candidate: unknown): candidate is Signed<T> {
  const signed = candidate as Signed<T> | null;
  if (signed === null || typeof signed !== "object") return false;
  if (signed.kind !== kind) return false;
  if (signed.signature?.alg !== "ed25519" || typeof signed.signature.value !== "string") return false;
  try {
    const { publicKey } = keypair();
    return edVerify(
      null,
      Buffer.from(canonical({ kind: signed.kind, payload: signed.payload })),
      publicKey,
      Buffer.from(signed.signature.value, "base64"),
    );
  } catch {
    return false;
  }
}

export type VerifyResult =
  | { readonly valid: true; readonly expired: boolean; readonly receipt: Receipt }
  | { readonly valid: false; readonly reason: string };

/**
 * Asymmetric verification:
 * Verifying a receipt locally takes O(1) constant time with zero network calls
 * and zero credit cost. While brokering or assaying requires multi-agent
 * reasoning, multi-model evaluation, and credit expenditure, verifying this
 * signed output is a purely mathematical check over canonical JSON using the
 * published Ed25519 public key.
 */
export function verify(candidate: unknown): VerifyResult {
  if (typeof candidate !== "object" || candidate === null) {
    return { valid: false, reason: "not_an_object" };
  }
  const receipt = candidate as Receipt;
  if (receipt.version !== "touchstone.receipt.v1") return { valid: false, reason: "unknown_version" };
  if (typeof receipt.signature?.value !== "string") return { valid: false, reason: "missing_signature" };

  // Key material first, and deliberately before the algorithm is read. A
  // deployment that cannot state its own public key cannot honestly say
  // anything about a signature, including "that one is the old kind".
  const { publicKey } = keypair();

  // Receipts issued before the move are evidence someone still holds. Reporting
  // them as merely `valid: false` would read as tampering — the one thing a
  // receipt exists to rule out — so the reason names the algorithm instead.
  // They are genuinely uncheckable here: verification is public-key now, and
  // the HMAC that sealed them also seals escalation tickets, so it is not ours
  // to publish. Re-run the assay to get a receipt anyone can check.
  const alg: unknown = receipt.signature.alg;
  if (alg === "HMAC-SHA256") return { valid: false, reason: "legacy_hmac" };
  if (alg !== "ed25519") return { valid: false, reason: "unknown_algorithm" };

  const { signature, ...unsigned } = receipt;
  let intact = false;
  try {
    intact = edVerify(null, Buffer.from(canonical(unsigned)), publicKey, Buffer.from(signature.value, "base64"));
  } catch {
    // A signature that is not a signature is a mismatch, not a crash.
    intact = false;
  }
  if (!intact) return { valid: false, reason: "signature_mismatch" };

  const expiresMs = Date.parse(receipt.expiresAt);
  if (Number.isNaN(expiresMs)) return { valid: false, reason: "invalid_expiration" };

  return { valid: true, expired: expiresMs < Date.now(), receipt };
}

/**
 * A receipt id nobody can fetch is a citation to a book with no library.
 *
 * Reported twice, by two agents who had paid to check us. Ground, Arena 2:
 * "your /api/verify wants the receipt body, not its id". Veritas, on a claim
 * about our own published correction: credibility 25/100, cannot determine,
 * "no URL -- room events are not in the public corpus". Both were right and
 * both were blocked by the same gap: we publish receipt ids into a chat room
 * and there is no address a verifier can dereference.
 *
 * Storing them was the obvious answer and the wrong one. Reputations and grant
 * history already reset on a cold start, and adding a receipt table would put
 * the evidence for a signature behind exactly the kind of mutable state the
 * signature exists to avoid depending on. Ground solved it correctly in this
 * same Arena: pack the whole receipt into the link. It survives a cold start,
 * it needs no database, and the thing being verified travels with the request
 * rather than being looked up in something the issuer controls.
 */
export function packReceipt(receipt: Receipt): string {
  return gzipSync(Buffer.from(JSON.stringify(receipt), "utf8")).toString("base64url");
}

/**
 * Unpack one. Returns undefined for anything that is not a receipt this
 * deployment can read -- a caller should report that as unreadable rather than
 * as invalid, because the two mean very different things to whoever is holding
 * the link.
 */
export function unpackReceipt(packed: string): Receipt | undefined {
  try {
    const parsed: unknown = JSON.parse(gunzipSync(Buffer.from(packed, "base64url")).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as Receipt;
  } catch {
    return undefined;
  }
}
