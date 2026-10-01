import { realpathSync } from "node:fs";
import path from "node:path";
import {
  completionGuidance,
  currentExecutionCuts,
  heldLeaseForExecutionActor,
  isNativeExecution,
  isSameExecution,
  isSamePerson,
  isTaskEvent,
  ledgerGitPath,
  resolveCompletionContract,
  resolveLedgerGitLayout,
  submissionFromCloseout,
  submissionDigest,
  sameWriteSource,
  type SubmissionV1,
  type WriteReceiptDraft,
} from "@harness-anything/kernel";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction, Snapshot } from "./repo-cell-types.ts";
import { assertCurrentSubmittedExecution } from "./repo-cell-execution-selection.ts";
import {
  artifactAnchorGuidance,
  artifactAnchors,
  readSubmissionArtifact,
  submissionArtifactDirectoryFiles,
  submissionArtifactPath,
  unparsedArtifactAnchorText,
} from "./submission-artifacts.ts";
import { runDocAction } from "./doc-sync-actions.ts";
import { makeGitReadinessSource, runProcessText } from "./process-port.ts";
import { repositoryBaseRef } from "./schedule-occurrence-workspace.ts";
import { readTaskTransitionDocument } from "./transition-document-access.ts";
import {
  isPresetSnapshotCurrent,
  prepareSubmissionEvidence,
  upgradeDriftedPresetSnapshot,
} from "./repo-cell-task-progress.ts";
import { actionWitnessCollections } from "./repo-cell-witness-adapters.ts";
import { dispatchInReviewCutReview } from "./task-review-dispatch.ts";
import { presetSnapshotReader, taskOutputShape, taskWorktreeBinding } from "./task-worktree.ts";

/** Git resolves the empty-tree object id virtually; it exists in every repository. */
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Structured execution binding selects the public delivery commit; Summary only selects artifacts. */
export function deriveCloseoutSubmission(
  cell: Pick<RepoCellOperationalContext, "rootDir" | "projection" | "store" | "cellCodedError" | "settings">,
  taskId: string,
  executionId: string,
  snapshot: Snapshot,
  bodyOverrides?: ReadonlyMap<string, string>,
  requestedCommit?: string,
): SubmissionV1 {
  const document = readTaskTransitionDocument({
      projection: cell.projection,
      taskId,
      slot: "task.closeout",
      bodyOverrides,
    }),
    frozen = snapshot.executions.find((execution) => execution.executionId === executionId)?.submission,
    // Parse/validate before reading any Git cut. No risk or verification line is filtered.
    parsed = submissionFromCloseout(
      document.body,
      {
        commitSha: "0".repeat(40),
        deliverables: [],
        outputs: [],
        completionContract: { gates: [] },
      },
      document.contract ?? undefined,
    ),
    // The execution's first submission freezes the gate requirements; resumes and amendments keep them.
    prose = { ...parsed, completionContract: frozen?.completionContract ?? freezeCompletionContract(cell, snapshot) },
    anchors = artifactAnchors(prose.completionClaim, document.packagePath),
    unparsed = unparsedArtifactAnchorText(prose.completionClaim);
  if (unparsed.length !== 0)
    throw cell.cellCodedError(
      "invalid_submission",
      `Summary contains artifact: text that is not a parsable anchor: ${unparsed.join(", ")}. ` +
        artifactAnchorGuidance,
    );
  const artifacts = anchors.flatMap(({ path, revision }) => {
    if (!path.endsWith("/")) {
      const artifact = submissionArtifactPath(document.packagePath, path);
      const acceptedRevision = revision ?? cell.projection.readDocument(artifact).document?.workspaceRevision;
      if (acceptedRevision === undefined)
        throw cell.cellCodedError(
          "invalid_submission",
          `Artifact ${artifact}: no center-accepted revision exists. ${artifactAnchorGuidance}`,
        );
      return [readSubmissionArtifact(cell, document.packagePath, artifact, acceptedRevision).anchor];
    }
    // Directory deliverable: expand to every file under it; each pins its own current
    // center-accepted revision, and any unfiled file rejects the submit naming the count.
    if (revision !== undefined)
      throw cell.cellCodedError(
        "invalid_submission",
        `Artifact ${path}: a directory deliverable pins each file's own accepted revision; ` +
          `remove @${String(revision)}. ` +
          artifactAnchorGuidance,
      );
    const directoryArtifact = submissionArtifactPath(document.packagePath, path),
      files = submissionArtifactDirectoryFiles(cell.rootDir, directoryArtifact);
    if (files.length === 0)
      throw cell.cellCodedError(
        "invalid_submission",
        `Artifact ${path}: the directory deliverable contains no files. ${artifactAnchorGuidance}`,
      );
    const unfiled = files.filter(
      (file) => cell.projection.readDocument(file).document?.workspaceRevision === undefined,
    );
    if (unfiled.length > 0)
      throw cell.cellCodedError(
        "invalid_submission",
        `Artifact ${path}: ${String(unfiled.length)} of ${String(files.length)} file(s) have no center-accepted ` +
          `revision (${unfiled.slice(0, 8).join(", ")}${unfiled.length > 8 ? ", …" : ""}). File every deliverable ` +
          "with ha doc sync --submit --task <task-id> or ha task artifact add before ha task submit. " +
          artifactAnchorGuidance,
      );
    return files.map((file) => {
      const acceptedRevision = cell.projection.readDocument(file).document?.workspaceRevision;
      return readSubmissionArtifact(cell, document.packagePath, file, acceptedRevision!).anchor;
    });
  });
  if (new Set(artifacts.map((anchor) => anchor.path)).size !== artifacts.length)
    throw cell.cellCodedError(
      "invalid_submission",
      `Summary must name each artifact path once. ${artifactAnchorGuidance}`,
    );
  // The delivery falls to the task's own output shape, not its completion gates (dec_BBA713052997C3EF5F5D3DD952):
  // a repository-diff task always carries a public delivery commit, even under a lightweight profile whose
  // gate set is empty; a task-package-artifact task always delivers through the ledger or anchored artifacts.
  const readPresetSnapshot = presetSnapshotReader(cell.projection),
    privateDelivery = taskOutputShape(snapshot.task, readPresetSnapshot) !== "repository-diff";
  if (privateDelivery) {
    if (artifacts.length)
      return {
        ...prose,
        commitSha: null,
        artifacts,
        deliverables: artifacts.map((anchor) => anchor.path),
        outputs: [],
      };
    let ledger: ReturnType<typeof resolveLedgerGitLayout>;
    try {
      ledger = resolveLedgerGitLayout(cell.rootDir);
    } catch {
      throw cell.cellCodedError(
        "invalid_submission",
        `No accepted task artifacts were found. ${artifactAnchorGuidance}`,
      );
    }
    const git = makeGitReadinessSource(),
      ledgerArtifacts = git.run(ledger.rootDir, [
        "ls-tree",
        "-r",
        "--name-only",
        "HEAD",
        "--",
        ledgerGitPath(ledger, `${document.packagePath}/artifacts/`),
      ]);
    if (!ledgerArtifacts.ok || (!ledgerArtifacts.stdout && artifacts.length === 0))
      throw cell.cellCodedError(
        "invalid_submission",
        `No accepted task artifacts were found under harness/${document.packagePath}/artifacts/. ` +
          artifactAnchorGuidance,
      );
    return {
      ...prose,
      // A retry must retain the already submitted ledger cut: materializing the submission itself
      // advances ledger HEAD, but does not change the documentation delivery.
      commitSha: frozen?.commitSha ?? git.run(ledger.rootDir, ["rev-parse", "HEAD"]).stdout,
      ...(artifacts.length ? { artifacts } : {}),
      deliverables: ledgerArtifacts.stdout
        ? ledgerArtifacts.stdout.split("\n")
        : artifacts.map((anchor) => anchor.path),
      outputs: artifacts.map((anchor) => `Artifact-Anchor: ${anchor.path}@${anchor.revision}`),
    };
  }
  const dispatches = cell.projection
      .readRuntimeDispatchesByTaskExecution(taskId, executionId)
      .map(({ event }) => event.payload)
      .filter((dispatch) => dispatch.role !== "reviewer" && dispatch.cwd),
    binding = taskWorktreeBinding(snapshot.task, readPresetSnapshot),
    taskRoot = binding ? path.join(cell.rootDir, binding.path) : null,
    git = makeGitReadinessSource(),
    // Only the bound task worktree names a delivery implicitly: a dispatch cwd may be any checkout,
    // canonical included, so it only locates an explicitly requested commit below.
    // A plain directory at the bound path would resolve to the enclosing checkout, so the path must be its own top level.
    boundHead = taskRoot ? git.run(taskRoot, ["rev-parse", "--show-toplevel", "HEAD"]) : null,
    [boundTop, boundSha] = boundHead?.ok ? boundHead.stdout.split("\n") : [],
    bound = boundTop && boundSha && realpathSync(boundTop) === realpathSync(taskRoot!) ? boundSha : undefined,
    uniqueDirectories = [...new Set([...(taskRoot ? [taskRoot] : []), ...dispatches.map((dispatch) => dispatch.cwd!)])],
    namedCommit = requestedCommit ?? bound;
  if (!namedCommit)
    throw cell.cellCodedError(
      "invalid_submission",
      "No readable bound worktree HEAD exists; rerun with --commit <40-character-sha>.",
    );
  if (requestedCommit && bound && requestedCommit !== bound)
    throw cell.cellCodedError(
      "invalid_submission",
      `Requested delivery commit ${requestedCommit} does not match bound worktree HEAD ${bound}.`,
    );
  const publishedRoot = [...new Set([...uniqueDirectories, cell.rootDir])].find(
    (candidate) => git.run(candidate, ["cat-file", "-e", `${namedCommit}^{commit}`]).ok,
  );
  if (!publishedRoot)
    throw cell.cellCodedError(
      "invalid_submission",
      `Delivery commit ${namedCommit} is not in any local clone of the bound or canonical repository; ` +
        "if it was just merged or pushed, run git fetch origin in the canonical checkout and rerun this command.",
    );
  const root = publishedRoot,
    commitSha = git.run(root, ["rev-parse", `${namedCommit}^{commit}`]).stdout;
  // Task delivery is not a Git publication state: a resolvable commit may be reviewed before it
  // becomes a bound worktree HEAD or reaches the default branch. The merge base below derives the cut's
  // file manifest only; it is not submission admission.
  const execution = snapshot.executions.find((value) => value.executionId === executionId),
    baseline = execution !== undefined && isNativeExecution(execution) ? execution.deliveryBaseline : undefined,
    defaultBranch = repositoryBaseRef(root),
    mergeBase = defaultBranch ? git.run(root, ["merge-base", defaultBranch, commitSha]) : { ok: false, stdout: "" },
    unchanged =
      baseline?.kind === "commit" ? baseline.commitSha === commitSha : baseline === undefined && bound === commitSha;
  let deliverables: readonly string[], commitOutputs: readonly string[];
  // An unchanged published HEAD is a delivery only when this task's earlier cut owns it.
  // The execution baseline detects new work; task history, rather than that observation,
  // distinguishes a restarted delivery from another task's baseline merge.
  const secondParent =
      unchanged && mergeBase.stdout === commitSha
        ? git.run(root, ["rev-parse", "--verify", "--quiet", `${commitSha}^2`])
        : null,
    priorDelivery =
      unchanged &&
      snapshot.executions.some((prior) => {
        const sha = prior.executionId !== executionId ? prior.submission?.commitSha : null;
        return (
          !!sha &&
          (secondParent?.ok === true
            ? git.run(root, ["merge-base", "--is-ancestor", sha, secondParent.stdout]).ok
            : sha === commitSha)
        );
      });
  if (unchanged && mergeBase.ok && mergeBase.stdout === commitSha && !priorDelivery) {
    deliverables = [];
    commitOutputs = [];
  } else if (frozen?.commitSha === commitSha) {
    // A submitted commit already owns its file manifest. Advancing main must not
    // shrink a branch-wide diff to the last commit; prose and artifacts remain freshly derived.
    deliverables = frozen.deliverables;
    commitOutputs = frozen.outputs.filter((output) => !output.startsWith("Artifact-Anchor: "));
  } else {
    // One delivery commit owns one manifest: the comparison cut derives from the commit's own fork
    // point on the default branch, never from where the project HEAD happened to sit when the execution
    // started (F-70FB11C4). Advancing main cannot move a merge base, so the manifest stays identical
    // across submit, publication, and re-derivation. A repository without a remote, or without origin/HEAD,
    // anchors on the branch its main checkout has out: that local branch is where its deliveries land.
    let base: string;
    if (mergeBase.ok && mergeBase.stdout !== commitSha) {
      // Unpublished fork: everything reachable from the commit and not from the default branch.
      base = mergeBase.stdout;
    } else if (mergeBase.ok || baseline === undefined) {
      // A published cut — the merge base is the commit itself — compares against its first parent:
      // the pre-merge main of a merge commit is exactly that PR's branch-wide diff. Executions from
      // before the baseline freeze (dec_D23B9787328EF7E0FACB70F9FE) keep the same first-parent rule. A root
      // commit has no first parent: it delivers its whole tree only when the execution started before any commit.
      const firstParent = git.run(root, ["rev-parse", "--verify", "--quiet", `${commitSha}^1`]);
      base = firstParent.ok ? firstParent.stdout : baseline?.kind === "empty-tree" ? EMPTY_TREE_SHA : "";
    } else {
      // Repositories with no default branch to anchor against (unborn, or a main checkout on a detached HEAD) have
      // no derivable fork point; the start-frozen observation is the only record of where the delivery began.
      base = baseline.kind === "commit" ? baseline.commitSha : EMPTY_TREE_SHA;
      if (baseline.kind === "commit" && !git.run(root, ["cat-file", "-e", `${baseline.commitSha}^{commit}`]).ok)
        throw cell.cellCodedError(
          "invalid_submission",
          `Frozen delivery baseline ${baseline.commitSha} is not readable in the delivery repository.`,
        );
    }
    if (!base) throw cell.cellCodedError("invalid_submission", "Delivery commit has no verifiable comparison cut.");
    deliverables = runProcessText(
      "git",
      ["diff", "--name-only", "-z", "--diff-filter=ACMRT", base, commitSha, "--"],
      root,
    )
      .split("\0")
      .filter(Boolean);
    commitOutputs = runProcessText("git", ["diff", "--name-only", "-z", "--diff-filter=D", base, commitSha, "--"], root)
      .split("\0")
      .filter(Boolean)
      .map((target) => `Deleted-Production-Paths: ${target}`);
  }
  // Deliverables stay paths of the delivery commit: anchored in-package artifacts ride in the
  // artifacts field and outputs lines so commit-based gates never verify ledger paths against
  // the public cut.
  return {
    ...prose,
    commitSha,
    ...(artifacts.length ? { artifacts } : {}),
    deliverables,
    outputs: [...commitOutputs, ...artifacts.map((anchor) => `Artifact-Anchor: ${anchor.path}@${anchor.revision}`)],
  };
}

function freezeCompletionContract(
  cell: Pick<RepoCellOperationalContext, "cellCodedError" | "settings">,
  snapshot: Snapshot,
): SubmissionV1["completionContract"] {
  const resolved = resolveCompletionContract(snapshot.task?.completionGateIds ?? [], cell.settings.readRepository());
  if (!resolved.ok) throw cell.cellCodedError("gate_mapping_invalid", resolved.message);
  // The cut freezes the resolved reviewer declaration so a later settings change never redirects a
  // cut already under review; cuts frozen before the field fall back to the repository default.
  return {
    ...resolved.contract,
    reviewer: { agentId: cell.settings.readRepository().roles?.defaultReviewer ?? "closeout-reviewer" },
  };
}

/**
 * The submit/amend advisory: accepted artifact deliveries moved under an unchanged closeout.
 * `outputs`, `deliverables`, `commitSha`, and `artifacts` all derive from the delivery cut rather
 * than closeout.md, so prose equality compares only the fields `submissionFromCloseout` authors.
 * Digest reuse keeps one submission-identity mechanism; the warning never gates the write.
 */
const closeoutProse = (value: SubmissionV1): SubmissionV1 => ({
  ...value,
  deliverables: [],
  outputs: [],
  commitSha: null,
  artifacts: [],
});

export function submissionAnchorDriftWarnings(
  previous: SubmissionV1 | null | undefined,
  submission: SubmissionV1,
): readonly string[] {
  if (
    !previous ||
    submissionDigest(previous) === submissionDigest(submission) ||
    submissionDigest(closeoutProse(previous)) !== submissionDigest(closeoutProse(submission))
  )
    return [];
  return [
    "Anchored artifact deliveries changed while the closeout prose did not; " +
      "verify the closeout claim still describes the delivered artifacts.",
  ];
}

/**
 * An amendment replaces the in-review cut, so the prior review no longer covers it: the center
 * dispatches the reviewer for the new cut through the forward's own path. Before owner triage the
 * amendment dispatches nothing; the forward will.
 */
async function amendedCutReview(
  cell: RepoCellOperationalContext,
  taskId: string,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  receipt: WriteReceiptDraft,
): Promise<readonly WriteReceiptDraft[]> {
  if (action.amend !== true) return [];
  const dispatched = await dispatchInReviewCutReview(cell, taskId, action, binding, receipt);
  return dispatched ? [dispatched.step] : [];
}

export async function submitTask(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): Promise<WriteReceiptDraft> {
  if (["submission", "fromFile", "jsonInput"].some((field) => action[field] !== undefined))
    throw cell.cellCodedError(
      "invalid_command",
      "Write closeout.md, then run ha task submit without a submission packet.",
    );
  // Owner recovery retains the ordinary lease proof: rejoin the active execution through the
  // existing settle path, then return here as a normal lease holder. `--as-owner` does not grant
  // a lease-free write or replace the worker's recorded execution attribution.
  if (action.asOwner === true && action.amend !== true) return settleTask(cell, { ...action, asOwner: false }, binding);
  const taskId = cell.requiredCellText(action.taskId, "taskId"),
    current = await cell.service.read(taskId),
    held = heldLeaseForExecutionActor(current.snapshot, undefined, binding.actor),
    cuts = currentExecutionCuts(current.snapshot),
    selected =
      typeof action.executionId === "string"
        ? current.snapshot.executions.find((execution) => execution.executionId === action.executionId)
        : held
          ? current.snapshot.executions.find((execution) => execution.executionId === held.executionId)
          : cuts.length === 1
            ? cuts[0]
            : undefined;
  const ownerAmendment =
    action.amend === true &&
    action.asOwner === true &&
    current.snapshot.task !== null &&
    isSamePerson(current.snapshot.task.createdBy, binding.actor);
  // An owning principal who rejoined from a terminal holds the lease without an executor
  // descriptor; the execution still records the runtime that did the work. First submission
  // through that held lease is admitted on person identity alone — the ordinary lease, source,
  // version, and CAS checks below still gate it.
  const ownerSubmission =
    action.amend !== true &&
    selected !== undefined &&
    selected.submission === null &&
    current.snapshot.task !== null &&
    isSamePerson(current.snapshot.task.createdBy, binding.actor) &&
    isSamePerson(selected.actor, binding.actor);
  // Recovery authority is the submission event caller, not the retained execution attribution.
  const submissionOpId =
      selected?.submission && action.amend !== true
        ? cell.projection.readTaskSubmissionOperation(taskId, selected.executionId)
        : null,
    event = submissionOpId === null ? null : cell.store.readEvent(submissionOpId);
  if (selected?.submission && action.amend !== true) {
    if (
      !event ||
      !isTaskEvent(event) ||
      event.type !== "execution_submitted" ||
      event.taskId !== taskId ||
      event.payload.execution.executionId !== selected.executionId ||
      !event.payload.execution.submission ||
      submissionDigest(event.payload.execution.submission) !== submissionDigest(selected.submission) ||
      !isSameExecution(event.actor, binding.actor) ||
      !sameWriteSource(event.source, binding.source)
    )
      throw cell.cellCodedError("lease_required", "Only the original submission holder may resume this cut.");
  }
  if (!selected || (!isSameExecution(selected.actor, binding.actor) && !ownerAmendment && !ownerSubmission && !event))
    return cell.lifecycleAction(action, binding);
  const executionId = selected.executionId,
    amendCommand = `ha task submit --amend ${taskId}${
      current.snapshot.task &&
      isSamePerson(current.snapshot.task.createdBy, binding.actor) &&
      !isSameExecution(selected.actor, binding.actor)
        ? " --as-owner"
        : ""
    }`;
  if (action.amend === true) assertCurrentSubmittedExecution(current.snapshot, taskId, executionId);
  if (!selected.submission && (!held || !sameWriteSource(current.snapshot.lease?.source, binding.source)))
    return cell.lifecycleAction(action, binding);
  if (Array.isArray(action.docChanges)) {
    // Reuse the existing atomic carried-document submission path. A submitted cut with
    // changed edge documents must be amended explicitly, never silently synchronized.
    if (selected.submission && action.amend !== true)
      throw cell.cellCodedError("invalid_transition", `Carried documents change a submitted cut; use ${amendCommand}.`);
    const receipt = await cell.runTaskCommandWithDocs(
      { ...action, executionId, docChanges: action.docChanges } as Parameters<typeof cell.runTaskCommandWithDocs>[0],
      binding,
    );
    if (receipt.outcome !== "applied") return receipt;
    // The submitted cut now waits for the owning CEO's triage (owner adjudication 2026-09-19):
    // a first submit dispatches nothing; evidence preparation still rides with the worker.
    const steps = await prepareSubmissionEvidence(cell, taskId, executionId, binding, actionWitnessCollections(action)),
      review = await amendedCutReview(cell, taskId, action, binding, receipt);
    return {
      ...(steps.find((step) => !["applied", "no_changes"].includes(step.outcome)) ?? receipt),
      steps: [...steps, ...review],
    } as WriteReceiptDraft;
  }
  // Assignment callers carry their changed documents above. With no carried changes,
  // consume center-accepted content; never scan the center worktree on an edge's behalf.
  const synced =
    typeof binding.source === "object" && binding.source.kind === "assignment"
      ? null
      : await runDocAction({
          action: { kind: "doc-submit", taskId },
          binding,
          rootDir: cell.rootDir,
          workspaceId: cell.input.repoId,
          store: cell.store,
          projection: cell.projection,
          now: cell.now,
        });
  if (synced && !["applied", "no_changes"].includes(synced.outcome))
    return {
      ...synced,
      next: [
        completionGuidance(
          current.snapshot,
          executionId,
          `ha task submit ${taskId}`,
          `Document synchronization is ${synced.outcome}; resume this submission after receipt ${synced.opId} settles.`,
        ),
      ],
    } as WriteReceiptDraft;
  const fresh = await cell.service.read(taskId),
    derived = readCloseoutSubmission(
      cell,
      taskId,
      executionId,
      fresh.snapshot,
      undefined,
      typeof action.commitSha === "string" ? action.commitSha : undefined,
    );
  if (!derived.ok)
    return submissionStopped(
      cell,
      action,
      binding,
      fresh.snapshot,
      executionId,
      fresh.packagePath,
      derived.error,
      synced ? [synced] : [],
    );
  const submission = derived.submission,
    anchorDriftWarnings = submissionAnchorDriftWarnings(selected.submission, submission);
  // A lost response resumes the stored cut only when the synchronized closeout still derives the same submission.
  if (selected.submission && action.amend !== true) {
    if (submissionDigest(selected.submission) !== submissionDigest(submission))
      return {
        ...cell.rejected(
          cell.operationId(action, binding, cell.input.repoId, fresh.snapshot.revision),
          "invalid_transition",
        ),
        rejectionExplanation: "The closeout or anchored artifacts differ from the submitted cut.",
        next: [
          completionGuidance(
            fresh.snapshot,
            executionId,
            amendCommand,
            "Amend the submitted cut explicitly before review.",
          ),
        ],
        steps: synced ? [synced] : [],
      } as WriteReceiptDraft;
    const receipt = cell.receiptForOperation(event!.opId, binding);
    if (receipt.outcome !== "applied") return receipt;
    const steps = await prepareSubmissionEvidence(cell, taskId, executionId, binding, actionWitnessCollections(action));
    return {
      ...(steps.find((step) => !["applied", "no_changes"].includes(step.outcome)) ?? receipt),
      steps,
    } as WriteReceiptDraft;
  }
  if (selected.submission && submissionDigest(selected.submission) === submissionDigest(submission))
    return submitTask(cell, { ...action, amend: false }, binding);
  const receipt = await cell.lifecycleAction({ ...action, executionId, submission }, binding);
  if (receipt.outcome !== "applied") return receipt;
  const steps = await prepareSubmissionEvidence(cell, taskId, executionId, binding, actionWitnessCollections(action)),
    review = await amendedCutReview(cell, taskId, action, binding, receipt);
  return {
    ...(steps.find((step) => !["applied", "no_changes"].includes(step.outcome)) ?? receipt),
    ...(anchorDriftWarnings.length ? { warnings: anchorDriftWarnings } : {}),
    steps: [...(synced ? [synced] : []), ...steps, ...review],
  } as WriteReceiptDraft;
}

/**
 * `ha task settle`: the deterministic half of post-delivery work, assembled once. Lease
 * admission rides the ordinary task-start catalog entry; the delivery itself is exactly one
 * `submitTask` call — no second doc-submit or evidence-preparation pipeline exists here.
 * Anything needing judgment (missing closeout prose, a foreign holder, a cut that differs
 * from what is stored, a preset that moved) stops on the step that rejected it.
 */
export async function settleTask(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): Promise<WriteReceiptDraft> {
  const taskId = cell.requiredCellText(action.taskId, "taskId"),
    current = await cell.service.read(taskId);
  if (!current.snapshot.task) throw cell.cellCodedError("entity_not_found", `Task ${taskId} does not exist.`);
  const held = heldLeaseForExecutionActor(current.snapshot, undefined, binding.actor),
    alreadySubmitted = currentExecutionCuts(current.snapshot).some((execution) => execution.state === "submitted"),
    steps: WriteReceiptDraft[] = [];
  // A submitted current round needs no lease — the holder checks inside submitTask decide
  // whether this caller may resume or amend that cut. Everything else needs a held lease;
  // the ordinary start path rejoins the active round execution or starts a fresh one and
  // rejects with its own guidance when admission is impossible.
  if (!held && !alreadySubmitted) {
    cell.assertTaskWipCapacity(taskId, "active");
    const started = await cell.lifecycleAction({ kind: "task-start", taskId }, binding);
    steps.push(started);
    if (!["applied", "no_changes"].includes(started.outcome)) return { ...started, steps } as WriteReceiptDraft;
  }
  const submitted = await submitTask(cell, { ...action, kind: "task-submit", taskId }, binding),
    mergedSteps = [...steps, ...((submitted as { readonly steps?: readonly WriteReceiptDraft[] }).steps ?? [])];
  if (submitted.outcome !== "applied") return { ...submitted, steps: mergedSteps } as WriteReceiptDraft;
  const fresh = await cell.service.read(taskId),
    submittedExecutionId =
      currentExecutionCuts(fresh.snapshot).find((execution) => execution.state === "submitted")?.executionId ?? "";
  // Preset drift used to stop settle on preset_snapshot_mismatch after the submitted cut was
  // already recorded. Run the same atomic upgrade `ha preset upgrade` performs — a real
  // preset_snapshot_upgraded event, never a forged digest — then let completion continue.
  // When the upgrade cannot compile, the canonical mismatch receipt below still stands.
  const upgrade = upgradeDriftedPresetSnapshot(
    cell,
    taskId,
    fresh.snapshot,
    fresh.packagePath,
    binding,
    `ha task settle ${taskId}`,
  );
  if (upgrade !== null) {
    if (upgrade.outcome !== "applied") return { ...upgrade, steps: [...mergedSteps, upgrade] } as WriteReceiptDraft;
    return { ...submitted, steps: [...mergedSteps, upgrade] } as WriteReceiptDraft;
  }
  if (
    fresh.snapshot.task?.presetSnapshotDigest &&
    !isPresetSnapshotCurrent(cell, taskId, fresh.snapshot, fresh.packagePath, `ha task settle ${taskId}`)
  )
    return {
      ...cell.rejected(
        cell.operationId(action, binding, cell.input.repoId, fresh.snapshot.revision),
        "preset_snapshot_mismatch",
      ),
      rejectionExplanation:
        "The submitted cut is recorded, but the task contract was written against an older preset snapshot.",
      next: [
        completionGuidance(
          fresh.snapshot,
          submittedExecutionId,
          `ha preset upgrade ${taskId}`,
          "Upgrade the task contract preset, then continue review and completion.",
        ),
      ],
      steps: mergedSteps,
    } as WriteReceiptDraft;
  return { ...submitted, steps: mergedSteps } as WriteReceiptDraft;
}

const submissionStopCodes = ["closeout_placeholder", "invalid_submission", "gate_mapping_invalid"];

export function submissionStopped(
  cell: Pick<RepoCellOperationalContext, "rejected" | "operationId" | "input">,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  snapshot: Snapshot,
  executionId: string,
  packagePath: string | null,
  error: unknown,
  steps: readonly WriteReceiptDraft[] = [],
): WriteReceiptDraft {
  if (!(error instanceof Error) || !("code" in error) || !submissionStopCodes.includes(String(error.code))) throw error;
  const code = error.code === "invalid_submission" ? "document_invalid" : String(error.code);
  return {
    ...cell.rejected(cell.operationId(action, binding, cell.input.repoId, snapshot.revision), code),
    // The remapped code alone cannot say why the document was rejected; the guard's own message can.
    rejectionExplanation: error.message,
    next: [
      completionGuidance(
        snapshot,
        executionId,
        code === "gate_mapping_invalid"
          ? `Map every declared gate in harness.yaml settings.gates, then run ha task submit ${String(action.taskId)}.`
          : `Fill harness/${packagePath}/closeout.md, run ha doc sync --submit --task ${String(action.taskId)}, ` +
              `then run ha task submit ${String(action.taskId)}.`,
        error.message,
      ),
    ],
    steps,
  } as WriteReceiptDraft;
}

export function readCloseoutSubmission(
  ...args: Parameters<typeof deriveCloseoutSubmission>
): { readonly ok: true; readonly submission: SubmissionV1 } | { readonly ok: false; readonly error: Error } {
  try {
    return { ok: true, submission: deriveCloseoutSubmission(...args) };
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || !submissionStopCodes.includes(String(error.code)))
      throw error;
    return { ok: false, error };
  }
}
