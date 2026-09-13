export { GET, runtime } from "../../agent-card.json/route";

/**
 * The address a cold prober tries first.
 *
 * Ground's paid audit failed this endpoint twice. The second pass named the
 * cause exactly: "a buyer's prober hits the URL you published, not the path
 * implied by your prose", and every other serious seller in this Arena --
 * TrustSieve, Arbiter, DeliverCheck, Veritas -- answers at
 * /.well-known/agent.json while Yuzu answered only at /agent-card.json.
 *
 * Same document, both addresses, one source. A discovery convention you have
 * to be told about in a chat room is not discovery.
 */
