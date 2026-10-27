import { readSubmissionFacts, type SubmissionV1 } from "@harness-anything/kernel";

/**
 * Path-triggered professional review: the repository-settings capability behind
 * `review.pathReviewers`. Each configured entry pairs one reviewer agent with one repository path —
 * a trailing separator marks a directory whose whole subtree matches, any other path matches that
 * exact file — and a submitted cut whose frozen manifest touches a configured path seats that agent
 * *instead of* the default reviewer (dec_6A77D43B8523823ABA1F5E4D3C CH1).
 *
 * There is no second passing gate here: a professional seat's findings enter the same per-finding
 * triage and settlement as any other seat. The product defines only the routing mechanism; which
 * agents watch which paths is repository configuration, and what a professional reviewer requires
 * lives in that agent's own declaration.
 *
 * The hit input is the complete changedFiles list frozen into new submissions, so dispatch-time
 * matching involves no Git invocation and stays deterministic on an edge as on the center.
 */

/** One configured path rule after grouping entries by agent. */
export interface ReviewPathRule {
  readonly agentId: string;
  readonly prefixes: readonly string[];
  readonly files: readonly string[];
}

/** A professional seat's routing evidence: the reviewer and the paths that matched it. */
export interface ReviewPathSeat {
  readonly agentId: string;
  readonly paths: readonly string[];
}

const LEGACY_PATH_EVIDENCE_UNAVAILABLE = "Legacy submission path evidence is incomplete; review the full delivery.";

/**
 * Group the configured entries into rules. The settings write boundary already rejects malformed
 * entries by pattern; this reader stays total and skips anything that does not parse, so a bad
 * entry can never fail a review dispatch.
 */
export function reviewPathRules(entries: readonly string[] | undefined): readonly ReviewPathRule[] {
  const rules = new Map<string, { prefixes: string[]; files: string[] }>();
  for (const entry of entries ?? []) {
    const separator = entry.indexOf(" ");
    if (separator <= 0) continue;
    const agentId = entry.slice(0, separator),
      path = entry.slice(separator + 1);
    if (agentId.length === 0 || path.length === 0) continue;
    const rule = rules.get(agentId) ?? { prefixes: [], files: [] };
    if (path.endsWith("/")) {
      if (!rule.prefixes.includes(path)) rule.prefixes.push(path);
    } else if (!rule.files.includes(path)) rule.files.push(path);
    rules.set(agentId, rule);
  }
  return [...rules].map(([agentId, { prefixes, files }]) => ({ agentId, prefixes, files }));
}

/**
 * The configured rules one submission hits: the frozen manifest's changed and deleted paths,
 * intersected with each rule's prefixes and exact files. An empty map leaves the default seat.
 */
export function reviewPathHits(
  submission: SubmissionV1 | null,
  rules: readonly ReviewPathRule[],
): ReadonlyMap<string, readonly string[]> {
  if (!submission || rules.length === 0) return new Map();
  const facts = readSubmissionFacts(submission),
    incompleteLegacy = facts.kind === "legacy" && facts.pathEvidence !== "complete",
    hits = new Map<string, string[]>();
  for (const rule of rules) {
    const matched = [
      ...ruleMatches(facts.changedFiles, rule),
      ...(incompleteLegacy ? [LEGACY_PATH_EVIDENCE_UNAVAILABLE] : []),
    ].sort();
    if (matched.length > 0) hits.set(rule.agentId, matched);
  }
  return hits;
}

/** The configured rules a plain path list hits; the risk-tier assessor reuses this on its own diff. */
export function reviewPathMatches(
  paths: readonly string[],
  rules: readonly ReviewPathRule[],
): ReadonlyMap<string, readonly string[]> {
  const hits = new Map<string, readonly string[]>();
  for (const rule of rules) {
    const matched = ruleMatches(paths, rule);
    if (matched.length > 0) hits.set(rule.agentId, matched);
  }
  return hits;
}

/** The professional seats a cut seats, in stable agent order, from one frozen hit map. */
export function reviewPathSeats(hits: ReadonlyMap<string, readonly string[]>): readonly ReviewPathSeat[] {
  return [...hits]
    .map(([agentId, paths]) => ({ agentId, paths }))
    .sort((left, right) => left.agentId.localeCompare(right.agentId));
}

/**
 * The routing evidence a professional seat's mission adds: why this reviewer holds the cut's one
 * seat. It names the hit paths and the configured scope, never a second passing rule — that seat's
 * findings go through the same per-finding triage and settlement as any other seat.
 */
export function reviewPathSeatPrompt(input: {
  readonly seat: { readonly reviewerId: string; readonly matchedPaths?: readonly string[] | undefined };
}): string {
  const agentId = input.seat.reviewerId,
    paths = input.seat.matchedPaths ?? [];
  return [
    `This cut's review seat is professional reviewer ${agentId}; the delivery's frozen manifest matched the ` +
      "repository's review.pathReviewers rule for this reviewer:",
    ...paths.map((path) => `- ${path}`),
    paths.includes(LEGACY_PATH_EVIDENCE_UNAVAILABLE)
      ? "This historical delivery has incomplete legacy path evidence, so the professional seat was chosen " +
        "conservatively. Review the full delivery within this reviewer's configured scope."
      : "Apply this reviewer's own declared focus to the delivery. Its findings are triaged and settled exactly " +
        "like any other seat's; holding this seat grants no separate approval.",
  ].join("\n");
}

function ruleMatches(paths: readonly string[], rule: ReviewPathRule): readonly string[] {
  return [
    ...new Set(
      paths.filter(
        (target) => rule.files.includes(target) || rule.prefixes.some((prefix) => target.startsWith(prefix)),
      ),
    ),
  ].sort();
}
