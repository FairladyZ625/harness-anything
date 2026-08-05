import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandReceiptEnvelope } from "@harness-anything/application";
import {
  DurableRepoWriteOutcomeStoreV1,
  repoWriteActorStampDigestV1,
  RepoWriteOutcomeConflictError,
  RepoWriteOutcomeCorruptionError,
  type RepoWriteProceedingInputV1,
  type RepoWriteTerminalEvidenceV1
} from "../../src/index.ts";
import { repoWriteProgressCommand } from "./repo-write-command-fixture.ts";

export function proceedingInput(outerOpId: string): RepoWriteProceedingInputV1 {
  return {
    ...axes(),
    outerOpId,
    innerOpId: `inner-${outerOpId}`,
    authoritySemanticDigest: "1".repeat(64),
    canonicalCommand: repoWriteProgressCommand(actorStamp(), {
      requestId: "request-1",
      presentation: "json"
    }),
    authenticatedContext: {
      actor: actorStamp(),
      presentation: { json: true }
    },
    receiptSeed: {
      schema: "repo-write-receipt-seed/v1",
      renderer: "cli-command-receipt/v2@1",
      generatedAt: "2026-07-23T12:00:00.000Z",
      command: "task create",
      action: "create",
      actorStampDigest: repoWriteActorStampDigestV1(actorStamp())
    },
    recoveryContext: {
      authorityEnvelopeDigest: "1".repeat(64),
      bindingTokenDigest: "2".repeat(64)
    }
  };
}

export function axes() {
  return {
    repoId: "repo-canonical",
    workspaceId: "workspace-canonical",
    generation: 1
  } as const;
}

export function successReceipt(): CommandReceiptEnvelope {
  return {
    ok: true,
    schema: "command-receipt/v2",
    command: "task create",
    action: "create",
    summary: "created task",
    entity: { kind: "task", id: "task_01KY" },
    paths: [{ role: "package", path: "harness/tasks/task_01KY" }],
    warnings: [{ code: "pending_materialization", message: "projection follows" }],
    next: [],
    details: {
      actor: actorStamp(),
      data: {
        taskId: "task_01KY",
        actorStamp: { personId: "person_zeyu", signature: "exact-child-value" }
      }
    },
    meta: {
      generatedAt: "2026-07-23T12:00:00.000Z",
      compatibility: { legacyReceipt: "CommandReceipt/v1" }
    }
  };
}

export function rejectedReceipt(): CommandReceiptEnvelope {
  return {
    ok: false,
    schema: "command-receipt/v2",
    command: "task create",
    action: "create",
    summary: "lease rejected",
    error: {
      code: "task_lease_required",
      hint: "Claim the task lease.",
      context: { taskId: "task_01KY" }
    },
    next: [{ command: "ha task claim task_01KY", description: "Claim and retry." }],
    details: { actor: actorStamp() },
    meta: {
      generatedAt: "2026-07-23T12:00:00.000Z",
      compatibility: { legacyReceipt: "CommandReceipt/v1" }
    }
  };
}

export function files(
  directory: string,
  phase: "proceeding" | "terminal"
): ReadonlyArray<string> {
  return readdirSync(directory)
    .filter((name) => name.endsWith(`.${phase}.json`))
    .sort();
}

export function actorStamp() {
  return {
    personId: "person_zeyu",
    displayName: "Zeyu Li",
    providerId: "local-socket",
    credential: {
      kind: "unix-socket-owner-boundary",
      issuer: "local-daemon",
      subject: "person_zeyu"
    }
  } as const;
}

export function terminalEvidence(
  input: Pick<RepoWriteProceedingInputV1, "innerOpId" | "workspaceId">,
  disposition: "committed" | "rejected"
): RepoWriteTerminalEvidenceV1 {
  return disposition === "committed" ? {
    tag: "COMMITTED",
    workspaceId: input.workspaceId,
    opId: input.innerOpId,
    semanticDigest: "1".repeat(64),
    revision: 1,
    commitSha: "a".repeat(40),
    previousCommit: null,
    authorityIntegrity: {
      schema: "authority-operation-integrity/v2",
      semanticRequestDigest: "1".repeat(64),
      semanticMutationSetDigest: "2".repeat(64),
      mutationRegistryVersion: 1,
      actorAxesBindingDigest: "3".repeat(64),
      canonicalMutationSet: { registryVersion: 1, mutations: [] }
    },
    integrityTuple: {
      schema: "authority-integrity-tuple/v2",
      canonicalEventDigest: "4".repeat(64),
      changeSetDigest: "5".repeat(64),
      semanticMutationSetDigest: "2".repeat(64),
      actorAxesBindingDigest: "3".repeat(64)
    }
  } : {
    tag: "REJECTED",
    workspaceId: input.workspaceId,
    opId: input.innerOpId,
    semanticDigest: "1".repeat(64),
    reason: "known durable rejection"
  };
}

export function withStore(
  run: (fixture: {
    readonly directory: string;
    readonly options: ConstructorParameters<typeof DurableRepoWriteOutcomeStoreV1>[0];
    readonly store: DurableRepoWriteOutcomeStoreV1;
  }) => void
): void {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-repo-write-outcome-"));
  try {
    const options = { directory: path.join(root, "outcomes"), ...axes() };
    run({
      directory: options.directory,
      options,
      store: new DurableRepoWriteOutcomeStoreV1(options)
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function conflict(error: unknown): boolean {
  return error instanceof RepoWriteOutcomeConflictError
    && error.code === "REPO_WRITE_OUTCOME_CONFLICT";
}

export function corrupt(error: unknown): boolean {
  return error instanceof RepoWriteOutcomeCorruptionError
    && error.code === "REPO_WRITE_OUTCOME_CORRUPT";
}
