import { submissionDigest, type ExecutionV1, type SubmissionV1 } from "@harness-anything/kernel";

/**
 * Path-triggered additional review lanes: the repository-settings capability behind
 * `review.pathReviewers`. Each configured entry pairs one reviewer agent with one repository
 * path — a trailing separator marks a directory whose whole subtree matches, any other path
 * matches that exact file — and a submitted cut whose frozen manifest touches a configured
 * path gets that agent dispatched beside the primary cut review. The product defines only the
 * mechanism; which agents watch which paths is repository configuration, and what a lane
 * reviews lives in the agent's own declaration.
 *
 * The hit input is the manifest submit froze into the submission (deliverables plus the
 * Deleted-Production-Paths output lines, see repo-cell-submit), so dispatch-time matching
 * involves no Git invocation and stays deterministic on an edge as on the center.
 */

/** One configured lane after grouping entries by agent. */
export interface ReviewPathLane {
  readonly agentId: string;
  readonly prefixes: readonly string[];
  readonly files: readonly string[];
}

const DELETED_OUTPUT_PREFIX = "Deleted-Production-Paths: ";

/**
 * Group the configured entries into lanes. The settings write boundary already rejects
 * malformed entries by pattern; this reader stays total and skips anything that does not
 * parse, so a lane never fails a review dispatch over its own configuration.
 */
export function reviewPathLanes(entries: readonly string[] | undefined): readonly ReviewPathLane[] {
  const lanes = new Map<string, { prefixes: string[]; files: string[] }>();
  for (const entry of entries ?? []) {
    const separator = entry.indexOf(" ");
    if (separator <= 0) continue;
    const agentId = entry.slice(0, separator),
      path = entry.slice(separator + 1);
    if (agentId.length === 0 || path.length === 0) continue;
    const lane = lanes.get(agentId) ?? { prefixes: [], files: [] };
    if (path.endsWith("/")) {
      if (!lane.prefixes.includes(path)) lane.prefixes.push(path);
    } else if (!lane.files.includes(path)) lane.files.push(path);
    lanes.set(agentId, lane);
  }
  return [...lanes].map(([agentId, { prefixes, files }]) => ({ agentId, prefixes, files }));
}

/**
 * The configured lanes one submission hits: the frozen manifest's changed and deleted paths,
 * intersected with each lane's prefixes and exact files. Empty map means no additional review.
 */
export function reviewLaneHits(
  submission: SubmissionV1 | null,
  lanes: readonly ReviewPathLane[],
): ReadonlyMap<string, readonly string[]> {
  const hits = new Map<string, string[]>();
  if (!submission || lanes.length === 0) return hits;
  const deleted = submission.outputs
    .filter((line) => line.startsWith(DELETED_OUTPUT_PREFIX))
    .map((line) => line.slice(DELETED_OUTPUT_PREFIX.length));
  const manifest = [...submission.deliverables, ...deleted];
  for (const lane of lanes) {
    const matched = [
      ...new Set(
        manifest.filter(
          (target) => lane.files.includes(target) || lane.prefixes.some((prefix) => target.startsWith(prefix)),
        ),
      ),
    ].sort();
    if (matched.length > 0) hits.set(lane.agentId, matched);
  }
  return hits;
}

/** A lane's own claim fence: the cut-review key grammar with the lane's agent as the segment. */
export function reviewLaneDispatchKey(agentId: string, taskId: string, execution: ExecutionV1): string {
  return `task-review-lane:${agentId}:${taskId}:${execution.executionId}:${execution.iteration}:${submissionDigest(
    execution.submission!,
  )}`;
}

/**
 * The mission every lane dispatch carries. It names the routing evidence (the hit paths), the
 * frozen cut, and the registration identity the reviewer credential enforces (reviewId
 * `review-<dispatchId>`, report and packet under the package's artifacts/reports). What the
 * lane should review and require is deliberately not restated here — the agent's own
 * declaration owns that; this prompt only binds the dispatch to its cut.
 */
export function reviewLanePrompt(input: {
  readonly agentId: string;
  readonly taskId: string;
  readonly packagePath: string;
  readonly dispatchId: string;
  readonly execution: ExecutionV1;
  readonly hits: readonly string[];
}): string {
  const { agentId, taskId, packagePath, dispatchId, execution, hits } = input,
    report = `${packagePath}/artifacts/reports/${dispatchId}.md`,
    packet = `${packagePath}/artifacts/reports/${dispatchId}.json`;
  return [
    `Independently review task ${taskId}, execution ${execution.executionId}, iteration ` +
      `${execution.iteration}, through the additional review lane for agent ${agentId}.`,
    `The exact submission digest is ${submissionDigest(execution.submission!)}.`,
    `This lane fired because the delivery's frozen manifest touches paths configured for this reviewer:` +
      `\n${hits.map((hit) => `- ${hit}`).join("\n")}`,
    `Read ha task show ${taskId} --json and select execution ${execution.executionId}; its submission ` +
      "is the authoritative delivery. Read the delivery diff yourself (deliveryBaseline -> submission " +
      "commit). Your own Agent declaration defines this lane's review focus, required output, and " +
      "verdict rules; apply it to the delivery as dispatched.",
    "On the first review, list every blocking finding visible in the frozen cut; do not defer a visible blocker " +
      "to a later round. On a re-review, verify the previous findings and inspect only the new diff.",
    `Write this lane's review report to harness/${report} and review input to harness/${packet}.`,
    `Register with ha task review-execution ${taskId} --execution-id ${execution.executionId} ` +
      `--review-id review-${dispatchId} --from-file harness/${packet}. ` +
      "These dispatch-specific paths and the review id are fixed; any other value is rejected.",
    "Do not submit, consent, or complete. If the submitted cut changes, stop and report it; " +
      "do not review the replacement under this dispatch.",
  ].join("\n");
}
