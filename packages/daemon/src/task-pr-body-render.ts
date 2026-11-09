import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  describeDependencyChange,
  deriveProtectedSurfaceRules,
  governanceDecisionAuthority,
  readSubmissionFacts,
  renderTaskPrBody,
  type SubmissionV1,
  type TaskProjectionQueries,
} from "@harness-anything/kernel";
import { runProcessText } from "./process-text.ts";
import { readTaskTransitionDocument } from "./transition-document-access.ts";

/**
 * The daemon-side adapter over the kernel PR-body renderer.
 *
 * Returns the re-render function the publication port uses for both create and update, or
 * `undefined` when this repository publishes no PR template / gate manifest. The latter keeps
 * repositories without Harness's PR-body convention on the legacy submission-prose body instead
 * of failing publication; the framework's own repository always supplies both files.
 *
 * `ha task push`, the submit refresh and terminal settlement all pass the closure into the one
 * publication port, so the rendered governance declaration and delivery facts are not a step a
 * worker can forget.
 */
export function taskPrBodyRenderer(input: {
  readonly rootDir: string;
  readonly projection: TaskProjectionQueries;
  readonly taskId: string;
  readonly submission: SubmissionV1;
}): ((body: string | undefined) => string) | undefined {
  const templatePath = path.join(input.rootDir, ".github", "pull_request_template.md"),
    manifestPath = path.join(input.rootDir, "tools", "gate-manifest.json");
  if (!existsSync(templatePath) || !existsSync(manifestPath)) return undefined;

  const template = readFileSync(templatePath, "utf8"),
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")),
    closeout = readTaskTransitionDocument({
      projection: input.projection,
      taskId: input.taskId,
      slot: "task.closeout",
    }),
    snapshot = input.projection.read(input.taskId).snapshot,
    facts = readSubmissionFacts(input.submission),
    dependencyDescription = describeDependencyChange({
      paths: facts.changedFiles,
      base: facts.productionDelta?.baseSha,
      head: input.submission.commitSha,
      read: {
        revisionExists: (revision) => gitRevisionExists(input.rootDir, revision),
        readManifest: (revision, manifestReadPath) => readManifestAt(input.rootDir, revision, manifestReadPath),
      },
    }),
    protectedSurfaceRules = deriveProtectedSurfaceRules(manifest),
    profileId = snapshot.task?.metadata?.profileId ?? null,
    decisionAuthority = governanceDecisionAuthority(snapshot.decisionRelations);

  return (body) =>
    renderTaskPrBody({
      taskId: input.taskId,
      submission: input.submission,
      profileId,
      decisionAuthority,
      template,
      body,
      closeout: closeout.body,
      protectedSurfaceRules,
      dependencyDescription,
    });
}

function gitRevisionExists(rootDir: string, revision: string): boolean {
  try {
    runProcessText("git", ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`], rootDir);
    return true;
  } catch {
    return false;
  }
}

function readManifestAt(rootDir: string, revision: string, manifestPath: string): unknown {
  // ls-tree is a value, not an exception: an absent path at that revision prints nothing and
  // exits zero. A missing revision cannot reach here because describeDependencyChange checks it.
  const listed = runProcessText("git", ["ls-tree", "--name-only", revision, "--", manifestPath], rootDir);
  return listed.trim().length === 0
    ? null
    : JSON.parse(runProcessText("git", ["show", `${revision}:${manifestPath}`], rootDir));
}
