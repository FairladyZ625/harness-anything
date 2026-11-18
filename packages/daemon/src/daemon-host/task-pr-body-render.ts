import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  describeDependencyChange,
  hasDependencyChange,
  deriveProtectedSurfaceRules,
  governanceDecisionAuthority,
  readSubmissionFacts,
  renderTaskPrBody,
  type SubmissionV1,
  type TaskProjectionQueries,
} from "@harness-anything/kernel";
import { runProcessExitAsync, runProcessTextAsync } from "./process-port.ts";
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
export async function taskPrBodyRenderer(input: {
  readonly rootDir: string;
  readonly projection: TaskProjectionQueries;
  readonly taskId: string;
  readonly submission: SubmissionV1;
}): Promise<((body: string | undefined) => string) | undefined> {
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
    dependencyDescription = await dependencyDescriptionFor(input.rootDir, input.submission),
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

async function dependencyDescriptionFor(rootDir: string, submission: SubmissionV1): Promise<string> {
  const facts = readSubmissionFacts(submission),
    paths = facts.changedFiles,
    base = facts.productionDelta?.baseSha,
    head = submission.commitSha,
    description = { paths, base, head };
  if (!hasDependencyChange(paths) || !base || !head) return describeDependencyChange(description);
  const revisions = await Promise.all(
    [base, head].map(async (revision) => {
      const result = await runProcessExitAsync(
        "git",
        ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`],
        rootDir,
      );
      return result.exitCode === 0;
    }),
  );
  if (revisions.some((exists) => !exists)) return describeDependencyChange(description);
  const manifests = new Map<string, unknown>();
  for (const manifestPath of new Set(
    paths.filter((file) => file !== "package-lock.json" && hasDependencyChange([file])),
  ))
    for (const revision of [base, head]) {
      const listed = await runProcessTextAsync(
        "git",
        ["ls-tree", "--name-only", revision, "--", manifestPath],
        rootDir,
      );
      manifests.set(
        `${revision}:${manifestPath}`,
        listed.trim()
          ? JSON.parse(await runProcessTextAsync("git", ["show", `${revision}:${manifestPath}`], rootDir))
          : null,
      );
    }
  return describeDependencyChange({
    ...description,
    read: {
      revisionExists: () => true,
      readManifest: (revision, manifestPath) => manifests.get(`${revision}:${manifestPath}`),
    },
  });
}
