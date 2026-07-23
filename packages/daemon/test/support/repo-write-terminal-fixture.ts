import type { CommandReceiptEnvelope } from "@harness-anything/application";
import {
  createRepoWriteProceedingOutcomeV1,
  createRepoWriteTerminalOutcomeV1,
  repoWriteActorStampDigestV1,
  type RepoWriteTerminalOutcomeV1
} from "../../src/runtime/repo-write-outcome-schema.ts";

const generatedAt = "2026-07-23T12:00:00.000Z";
const actor = {
  personId: "person_zeyu",
  displayName: "Zeyu Li",
  providerId: "local-socket",
  credential: {
    kind: "unix-socket-owner-boundary",
    issuer: "local-daemon",
    subject: "person_zeyu"
  }
} as const;

export function committedCommandReceipt(
  summary = "appended progress"
): CommandReceiptEnvelope {
  return {
    ok: true,
    schema: "command-receipt/v2",
    command: "progress append",
    action: "append",
    summary,
    details: { actor },
    meta: {
      generatedAt,
      compatibility: { legacyReceipt: "CommandReceipt/v1" }
    }
  };
}

export function rejectedCommandReceipt(
  summary = "task not found"
): CommandReceiptEnvelope {
  return {
    ok: false,
    schema: "command-receipt/v2",
    command: "progress append",
    action: "append",
    summary,
    error: {
      code: "task_not_found",
      hint: "Check the task id.",
      context: { taskId: "task_missing" }
    },
    details: { actor },
    meta: {
      generatedAt,
      compatibility: { legacyReceipt: "CommandReceipt/v1" }
    }
  };
}

export function committedTerminalOutcome(
  outerOpId: string,
  receipt = committedCommandReceipt()
): RepoWriteTerminalOutcomeV1 {
  return terminalOutcome(outerOpId, "committed", receipt, {});
}

export function rejectedTerminalOutcome(
  outerOpId: string,
  receipt = rejectedCommandReceipt()
): RepoWriteTerminalOutcomeV1 {
  return terminalOutcome(outerOpId, "rejected", receipt, {});
}

export function committedTerminalOutcomeForAxes(
  outerOpId: string,
  axes: Partial<{
    readonly repoId: string;
    readonly workspaceId: string;
    readonly generation: number;
  }>
): RepoWriteTerminalOutcomeV1 {
  return terminalOutcome(outerOpId, "committed", committedCommandReceipt(), axes);
}

function terminalOutcome(
  outerOpId: string,
  disposition: "committed" | "rejected",
  receipt: CommandReceiptEnvelope,
  axes: Partial<{
    readonly repoId: string;
    readonly workspaceId: string;
    readonly generation: number;
  }>
): RepoWriteTerminalOutcomeV1 {
  const innerOpId = `inner-${outerOpId}`;
  const semanticDigest = "1".repeat(64);
  const proceeding = createRepoWriteProceedingOutcomeV1({
    repoId: axes.repoId ?? "repo-canonical",
    workspaceId: axes.workspaceId ?? "workspace-canonical",
    generation: axes.generation ?? 3,
    outerOpId,
    innerOpId,
    authoritySemanticDigest: semanticDigest,
    canonicalCommand: {
      commandName: "progress.append",
      actor,
      context: {},
      payload: { taskId: "task_01KY", text: "progress" }
    },
    authenticatedContext: { actor },
    receiptSeed: {
      schema: "repo-write-receipt-seed/v1",
      renderer: "cli-command-receipt/v2@1",
      generatedAt,
      command: "progress append",
      action: "append",
      actorStampDigest: repoWriteActorStampDigestV1(actor)
    },
    recoveryContext: {
      authorityEnvelopeDigest: "2".repeat(64)
    }
  });
  return createRepoWriteTerminalOutcomeV1(proceeding, receipt, disposition === "committed"
    ? {
        tag: "COMMITTED",
        workspaceId: proceeding.workspaceId,
        opId: innerOpId,
        semanticDigest,
        revision: 1,
        commitSha: "a".repeat(40),
        previousCommit: null,
        authorityIntegrity: {
          schema: "authority-operation-integrity/v2",
          semanticRequestDigest: semanticDigest,
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
      }
    : {
        tag: "REJECTED",
        workspaceId: proceeding.workspaceId,
        opId: innerOpId,
        semanticDigest,
        reason: "known durable rejection"
      });
}
