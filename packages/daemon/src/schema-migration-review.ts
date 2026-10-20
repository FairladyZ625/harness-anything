import { submissionDigest, type ExecutionV1, type SubmissionV1 } from "@harness-anything/kernel";

/**
 * The persisted-shape surface registry: the one machine-readable criterion that routes a
 * destructive schema change to the `data-migration` reviewer. It names where this product
 * defines or validates the shapes of data that already exists on disk (the ledger's own
 * event/domain validators, published schema contracts, the store's event validation and
 * shape-migration registry, projection readers/replay, preset contracts and shipped preset
 * assets, and the canonical-event compatibility gate). A delivery whose frozen manifest
 * touches any of these surfaces owes a migration review; the criterion is path-exact
 * against this list, never a keyword guess over diff text.
 *
 * The registry lives in product code on purpose: it changes in the same commit as the
 * surfaces it names, and it is repo-relative so it fires in any repository that develops
 * this product (the self-hosted canonical checkout and its worktrees). Repositories that
 * only consume the product never diff these paths, so the lane stays silent there.
 */
const persistedShapeSurfacePrefixes = [
  "packages/kernel/src/domain/",
  "packages/kernel/src/schemas/",
  "packages/kernel/src/store/",
  "packages/kernel/src/projection/",
  "packages/preset/src/",
  "packages/preset/assets/",
] as const;

const persistedShapeSurfaceFiles = ["tools/gates/canonical-event-compat.mjs"] as const;

/** The specialist Agent this lane dispatches; bundled with the product, overridable by install. */
export const schemaMigrationAgentId = "data-migration" as const;

const DELETED_OUTPUT_PREFIX = "Deleted-Production-Paths: ";

/**
 * The frozen-manifest paths of one submission that touch a persisted-shape surface: the
 * deliverables list (added/copied/modified/renamed/typed) plus the Deleted-Production-Paths
 * output lines, intersected with the registry. The manifest was derived and frozen at submit
 * (see repo-cell-submit), so this read involves no Git invocation and is deterministic at
 * dispatch time, on an edge as on the center.
 */
export function persistedShapeSurfaceHits(submission: SubmissionV1 | null): readonly string[] {
  if (!submission) return [];
  const deleted = submission.outputs
    .filter((line) => line.startsWith(DELETED_OUTPUT_PREFIX))
    .map((line) => line.slice(DELETED_OUTPUT_PREFIX.length));
  const hits = new Set<string>();
  for (const target of [...submission.deliverables, ...deleted])
    if (
      persistedShapeSurfacePrefixes.some((prefix) => target.startsWith(prefix)) ||
      (persistedShapeSurfaceFiles as readonly string[]).includes(target)
    )
      hits.add(target);
  return [...hits].sort();
}

/** The schema-migration lane's own claim fence: same key grammar as the cut review, own lane segment. */
export function schemaReviewDispatchKey(taskId: string, execution: ExecutionV1): string {
  return `task-review-schema:${taskId}:${execution.executionId}:${execution.iteration}:${submissionDigest(
    execution.submission!,
  )}`;
}

/**
 * The review packet prompt every schema-migration dispatch carries. It states the routing
 * evidence (the hit surfaces), points at the frozen cut, and fixes the registration
 * identity fields the reviewer credential enforces (reviewId `review-<dispatchId>`, report
 * and packet under the package's artifacts/reports). The three-part output contract itself
 * lives in the Agent declaration's instructions, not here — this prompt names the target,
 * not the role.
 */
export function schemaMigrationReviewPrompt(input: {
  readonly taskId: string;
  readonly packagePath: string;
  readonly dispatchId: string;
  readonly execution: ExecutionV1;
  readonly hits: readonly string[];
}): string {
  const { taskId, packagePath, dispatchId, execution, hits } = input,
    report = `${packagePath}/artifacts/reports/${dispatchId}.md`,
    packet = `${packagePath}/artifacts/reports/${dispatchId}.json`;
  return [
    `Independently review the persisted-data migration of task ${taskId}, execution ` +
      `${execution.executionId}, iteration ${execution.iteration} (schema-migration lane).`,
    `The exact submission digest is ${submissionDigest(execution.submission!)}.`,
    `Routing criterion hit: this delivery's frozen manifest touches persisted-shape surfaces:` +
      `\n${hits.map((hit) => `- ${hit}`).join("\n")}`,
    `Read ha task show ${taskId} --json and select execution ${execution.executionId}; ` +
      "its submission is the authoritative delivery. Read the delivery diff yourself " +
      "(deliveryBaseline -> submission commit) and identify every removed, renamed, or narrowed " +
      "persisted field/entity/config and every changed normalization rule; already-persisted " +
      "derived rows (projection rows, snapshots, digest rows) count as old data too.",
    "Apply your declaration's standard three-part output contract: the affected-persisted-data " +
      "inventory (event stream, projection snapshots, harness.yaml, vertical.json, preset assets — " +
      "each face checked and answered), the attach-migration registration through the one upgrade " +
      "entry in packages/kernel/src/store/attach-migrations.ts, and real-old-copy evidence " +
      "(direct-start readable plus full cold rebuild). A delivery that retires or narrows a " +
      "persisted shape without all three is changes_requested; name the missing part.",
    `Write this lane's review report to harness/${report} and review input to harness/${packet}.`,
    `Register with ha task review-execution ${taskId} --execution-id ${execution.executionId} ` +
      `--review-id review-${dispatchId} --from-file harness/${packet}. ` +
      "These dispatch-specific paths and the review id are fixed; any other value is rejected.",
    "Do not submit, consent, or complete. If the submitted cut changes, stop and report it; " +
      "do not review the replacement under this dispatch.",
  ].join("\n");
}
