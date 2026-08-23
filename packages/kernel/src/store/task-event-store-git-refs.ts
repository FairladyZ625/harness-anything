import { createHash } from "node:crypto";
import path from "node:path";
import { consumeKnownError } from "../error-consumption.ts";
import { isAgentRuntimeEvent, runtimeEventContentClaims } from "../domain/agent-runtime.ts";
import { assertAgentEntityWritePlan, isAgentEntityEvent } from "../domain/agent-entity-event.ts";
import {
  assertDocSyncWritePlan,
  isDecisionEvent,
  isDocEvent,
  isFactEvent,
  isMigrationImportEvent,
  isTaskEvent,
  ledgerCommitSha,
  parseCanonicalEvent,
  serializeCanonicalEvent,
  validateCurrentCanonicalEvent,
  validateCurrentDocEvent,
  type CanonicalEventV1,
  type DocEventV1,
  type LedgerCommitSha,
} from "../domain/doc-sync.contract.ts";
import {
  assertMigrationImportWritePlan,
  migrationImportClaims,
  migrationImportContentClaims,
} from "../domain/migration-import-event.ts";
import {
  assertLedgerLayoutMigrationWritePlan,
  isLedgerLayoutMigrationEvent,
  ledgerLayoutMigrationWritePlan,
  type LedgerLayoutMigrationEventV1,
} from "../domain/ledger-layout-migration-event.ts";
import { assertDecisionWritePlan } from "../domain/decision-event.ts";
import { assertFactWritePlan } from "../domain/fact-event.ts";
import type { TaskEventV1 } from "../domain/task-lifecycle.contract.ts";
import { assertTaskLifecycleWritePlan } from "../domain/task-lifecycle-publication.ts";
import {
  assertTaskBootstrapWritePlan,
  isTaskBootstrapEvent,
  taskBootstrapClaims,
  type TaskBootstrapEventV1,
} from "../domain/task-bootstrap-event.ts";
import { assertTaskProgressWritePlan, isTaskProgressEvent } from "../domain/task-progress-event.ts";
import {
  assertSnapshotUpgradeInputs,
  isSnapshotUpgradeEvent,
  snapshotUpgradeClaims,
} from "../domain/task-snapshot-upgrade-store-seam.ts";
import {
  freezeDeclaredWritePlan,
  isFrozenWritePlan,
  serializeEventHead,
  type ActorIdentity,
  type EventHead,
  type FrozenWritePlan,
  type LedgerCutIdentity,
  type WriteSource,
  type WriteTarget,
} from "../domain/write-chain.contract.ts";
import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../layout/index.ts";
import {
  assertPublishableOpId,
  contentObjectRelativePath,
  eventObjectRelativePath,
  eventObjectShard,
  eventObjectTarget,
  type LedgerLayoutState,
  type LedgerObjectLayout,
} from "../layout/ledger-object-layout.ts";
import { ledgerGitPath, resolveLedgerGitLayout, type LedgerGitLayout } from "./ledger-git-layout.ts";
import {
  localGitObjectRefStore as gitObjects,
  localGitText,
  localGitWorktreeSettlement as worktree,
} from "./local-version-control-system.ts";
import type { PublicationFile } from "./task-event-store-types.ts";
import { CANONICAL_EVENT_REF, TaskEventStoreError } from "./task-event-store-types.ts";
import { messageOf } from "./task-event-store-materialization.ts";

// Temporary publication refs, atomic ref updates, and branch safety checks.
export function publicationRef(opId: string): string {
  return `refs/ha-event-prepared/${sha256Text(opId)}`;
}
export function prepareCommit(
  repoRoot: string,
  ref: string,
  parent: string,
  files: readonly PublicationFile[],
  opId: string,
  occurredAt: string,
): string {
  const message = `harness event ${opId}`,
    timestamp = Math.floor(Date.parse(occurredAt) / 1_000);
  let input = `commit ${ref}\nmark :1\ncommitter Harness Event Store <harness-event-store@local.invalid> ${timestamp} +0000\ndata ${Buffer.byteLength(message)}\n${message}\nfrom ${parent}\n`;
  for (const file of files)
    input +=
      "from" in file
        ? `R ${file.from} ${file.to}\n`
        : "delete" in file
          ? `D ${file.delete}\n`
          : `M ${file.mode} inline ${file.target}\ndata ${Buffer.byteLength(file.body)}\n${file.body}\n`;
  input += "\nget-mark :1\ndone\n";
  let output: Buffer;
  try {
    output = gitObjects.importCommit(repoRoot, input);
  } catch (error) {
    throw new TaskEventStoreError("publication_indeterminate", `Git object import failed: ${messageOf(error)}`);
  }
  const sha = output.toString("utf8").trim().split("\n").at(-1) ?? "";
  if (!/^[0-9a-f]{40}$/u.test(sha))
    throw new TaskEventStoreError("publication_indeterminate", "Git object import returned no commit");
  return sha;
}
export function preparedRefs(repoRoot: string): readonly (readonly [string, string])[] {
  return parseRefs(gitObjects.listRefs(repoRoot, ["refs/ha-event-prepared/"]));
}
export function publicationRefs(
  repoRoot: string,
  authoredRef: string,
): {
  readonly canonical: string | null;
  readonly authored: string | null;
  readonly prepared: readonly (readonly [string, string])[];
} {
  const refs = parseRefs(gitObjects.listRefs(repoRoot, [CANONICAL_EVENT_REF, authoredRef, "refs/ha-event-prepared/"])),
    find = (name: string) => refs.find(([ref]) => ref === name)?.[1] ?? null;
  return {
    canonical: find(CANONICAL_EVENT_REF),
    authored: find(authoredRef),
    prepared: refs.filter(([ref]) => ref.startsWith("refs/ha-event-prepared/")),
  };
}
export function parseRefs(body: string): readonly (readonly [string, string])[] {
  return body.trim()
    ? body
        .trim()
        .split(/\r?\n/u)
        .map((line) => line.split(" ") as [string, string])
    : [];
}
export function updateRef(repoRoot: string, ref: string, sha: string, previous?: string): void {
  gitObjects.updateRef(repoRoot, ref, sha, previous);
}
export function finalizeRefs(
  repoRoot: string,
  authoredRef: string,
  sha: string,
  previous: string,
  prepared?: readonly [string, string],
): void {
  gitObjects.updateRefs(
    repoRoot,
    `start\nupdate ${CANONICAL_EVENT_REF} ${sha} ${previous}\nupdate ${authoredRef} ${sha} ${previous}\n${prepared ? `delete ${prepared[0]} ${prepared[1]}\n` : ""}prepare\ncommit\n`,
  );
}
export function deleteRef(repoRoot: string, ref: string): void {
  gitObjects.deleteRef(repoRoot, ref);
}
export function assertPublicationCut(repoRoot: string, authoredRef: string, canonical: string): void {
  let refs: ReturnType<typeof publicationRefs>;
  try {
    refs = publicationRefs(repoRoot, authoredRef);
  } catch {
    throw new TaskEventStoreError(
      "publication_indeterminate",
      "authored and canonical refs cannot be resolved; reconcile before publishing",
    );
  }
  if (refs.authored !== canonical || refs.canonical !== canonical)
    throw new TaskEventStoreError(
      "publication_indeterminate",
      `ledger ${authoredRef} must point at the last published event commit ${canonical}, but a commit was made outside the daemon. Recover with: git -C ${repoRoot} update-ref ${authoredRef} ${canonical} — this moves only the branch pointer and leaves every file in place. Then run ha daemon stop and retry.`,
    );
}
export function currentBranch(repoRoot: string): string {
  const branch = gitObjects.currentBranch(repoRoot);
  if (branch) return branch;
  throw new TaskEventStoreError(
    "publication_indeterminate",
    "authored branch is detached; register a default branch before publishing",
  );
}
