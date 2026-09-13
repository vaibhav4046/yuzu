import { NextResponse, type NextRequest } from "next/server";

/**
 * An agent that asks the root for JSON should be handed the agent card.
 *
 * Ground's paid audit failed this endpoint twice and the second pass named the
 * cause precisely:
 *
 *   "NO_PARSEABLE_INVENTORY - your root answers with content-type text/html,
 *    so there is no services/tools block for a buyer to price or enumerate.
 *    Your /api/manifest carries all of it, but the prober never reaches it
 *    from the root."
 *
 * The root is the one URL every buying agent tries without being told, and it
 * was answering with a marketing page. The page is still the right answer for
 * a browser -- so the request decides: `Accept: application/json` gets the
 * card, everything else gets the site exactly as before.
 *
 * Deliberately a rewrite rather than a redirect: a prober that does not follow
 * 3xx still gets the document, and the URL it audits stays the URL it asked
 * for.
 */
export function middleware(request: NextRequest): NextResponse {
  const accept = request.headers.get("accept") ?? "";

  // Browsers send `text/html,...` with `*/*` at the tail, so a bare wildcard is
  // not evidence of a machine. Only an explicit JSON preference counts.
  const wantsJson = /\bapplication\/(?:json|ld\+json)\b/i.test(accept) && !/\btext\/html\b/i.test(accept);

  if (wantsJson) return NextResponse.rewrite(new URL("/agent-card.json", request.url));

  return NextResponse.next();
}

/** Only the root. Every other path already answers for itself. */
export const config = { matcher: "/" };
