import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { resolveHarnessLayout } from "@harness-anything/kernel";
import { writeFileDurably } from "@harness-anything/storage";
import {
  effectiveResidentCeoExecutionPolicy,
  evaluateResidentCeoLeaseBlock,
  parseResidentCeoTurnActions,
  RESIDENT_CEO_MAX_TIER0_ACTIONS_PER_TURN,
  type ResidentCeoLeaseSnapshot,
  type ResidentCeoProfile,
} from "@harness-anything/kernel/internal/domain/resident-ceo.ts";
import type {
  ResidentCeoActionReceipt,
  ResidentCeoDelegationExecutor,
  ResidentCeoProposalDraft,
  ResidentCeoTier0ActionInput,
} from "@harness-anything/application/internal/commands/resident-ceo.ts";
import type { DaemonHost } from "./daemon-host-types.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";

export interface ResidentCeoActionBridge {
  readonly host: Pick<DaemonHost, "run" | "spawnRuntime"> & Partial<Pick<DaemonHost, "steerRuntime">>;
  readonly codedError: (code: string, message: string) => Error;
  readonly resolveLocalNodeId?: () => string | null;
  readonly resolveRepoRoot?: () => string | null;
  readonly now?: () => string;
}

function parseReceiptEvidence(evidence: unknown): Record<string, unknown> | null {
  if (typeof evidence !== "string" || evidence.trim().length === 0) return null;
  const parsed: unknown = JSON.parse(evidence);
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function receiptFailureMessage(
  receipt: { readonly rejectionExplanation?: string | null; readonly nextAction?: string },
  fallback: string,
): string {
  return receipt.rejectionExplanation?.trim() || receipt.nextAction?.trim() || fallback;
}

function extractTaskSnapshot(evidence: Record<string, unknown> | null): {
  readonly task: {
    readonly taskId?: unknown;
    readonly status?: unknown;
    readonly packageDisposition?: unknown;
  } | null;
  readonly lease: ResidentCeoLeaseSnapshot | null;
  readonly executions: readonly unknown[];
  readonly packagePath: string | null;
} {
  const task =
    evidence?.task && typeof evidence.task === "object" && !Array.isArray(evidence.task)
      ? (evidence.task as {
          readonly taskId?: unknown;
          readonly status?: unknown;
          readonly packageDisposition?: unknown;
        })
      : null;
  const lease =
    evidence?.lease && typeof evidence.lease === "object" && !Array.isArray(evidence.lease)
      ? (evidence.lease as ResidentCeoLeaseSnapshot)
      : null;
  const executions = Array.isArray(evidence?.executions) ? evidence.executions : [];
  const packagePath =
    typeof evidence?.packagePath === "string" && evidence.packagePath.trim().length > 0
      ? evidence.packagePath.trim()
      : null;
  return { task, lease, executions, packagePath };
}

function requireUnblockedLease(
  bridge: ResidentCeoActionBridge,
  taskId: string,
  lease: ResidentCeoLeaseSnapshot | null,
  principalPersonId: string | null,
  nowIso: string,
): { readonly hasOwnExpiredLease: boolean } {
  const checked = evaluateResidentCeoLeaseBlock({ taskId, lease, principalPersonId, nowIso });
  if (checked.blocked) throw bridge.codedError(checked.code, checked.message);
  return { hasOwnExpiredLease: checked.hasOwnExpiredLease };
}

export function buildResidentCeoHumanChatPrompt(profile: ResidentCeoProfile, message: string): string {
  if (effectiveResidentCeoExecutionPolicy(profile) !== "approval-gated") return message;
  return [
    "You are the owner's Resident CEO running in a read-only sandbox (permissionMode: read-only, MCP disabled).",
    "For normal questions, reply in plain text.",
    'When the owner asks you to execute an authorized Tier 0 or Tier 1 action, respond with a JSON object (optionally fenced in ```json) using either a single action or {"reply":"...","actions":[...]}.',
    "Supported Tier 0 actions (max 3 per turn): peer_ask {action,toPersonId,summary,requestKind?,claim?,requestedAction?,workId?}, peer_reply {action,requestId,claim,requestedAction?,outcome?,reason?}, runtime_steer {action,runtimeSessionId|dispatchId,prompt}.",
    'Supported Tier 1 actions (owner-direct auto-executed on human-chat): promote_and_dispatch {action,title,workId?,agentId?,targetNodeId?,prompt?,rationale}, start_and_dispatch_existing {action,taskId,agentId?,targetNodeId?,prompt?,rationale}, archive_or_cancel_unleased {action,taskId,cleanupMode?:"archive"|"cancel",rationale}, doc_sync_plan {action,taskId,planContent,rationale}.',
    "Tier 2 actions (review_consent, task_complete, force_takeover, merge_pr, modify_ci_gate) are strictly forbidden and always fail-closed rejected.",
    ...(profile.defaultWorkId ? [`Configured default workId: ${profile.defaultWorkId}`] : []),
    ...(profile.defaultAgentId ? [`Configured default agentId: ${profile.defaultAgentId}`] : []),
    "Owner message:",
    message,
  ].join("\n");
}

export function makeResidentCeoExtendedActionMethods(
  bridge: ResidentCeoActionBridge,
  repoId: string,
  auth: DaemonAuthenticationContext,
  assignToNode: NonNullable<ResidentCeoDelegationExecutor["assignToNode"]>,
): Pick<
  ResidentCeoDelegationExecutor,
  | "peerAsk"
  | "peerReply"
  | "runtimeSteer"
  | "createTask"
  | "startExistingTask"
  | "archiveOrCancelUnleased"
  | "syncTaskPlan"
> {
  const nowIso = (): string => bridge.now?.() ?? new Date().toISOString();

  return {
    peerAsk: async (input) => {
      const receipt = await bridge.host.run(
        repoId,
        {
          kind: "peer-ask",
          toPersonId: input.toPersonId,
          requestKind: input.requestKind ?? "question",
          summary: input.summary,
          claim: input.claim ?? input.summary,
          requestedAction: input.requestedAction ?? input.summary,
          ...(input.workId ? { workId: input.workId } : {}),
          ...(input.anchorRef ? { anchorRef: input.anchorRef } : {}),
          idempotencyKey: input.idempotencyKey,
        },
        auth,
      );
      if (receipt.outcome !== "applied" && receipt.outcome !== "no_changes") {
        throw bridge.codedError(
          receipt.code ?? "resident_ceo_peer_ask_failed",
          receiptFailureMessage(receipt, "PeerRequest creation was rejected."),
        );
      }
      const parsed = parseReceiptEvidence(receipt.evidence);
      const reqObj =
        parsed?.request && typeof parsed.request === "object" && !Array.isArray(parsed.request)
          ? (parsed.request as { readonly requestId?: unknown })
          : null;
      const requestId =
        typeof reqObj?.requestId === "string"
          ? reqObj.requestId
          : typeof parsed?.requestId === "string"
            ? parsed.requestId
            : null;
      if (requestId === null) {
        throw bridge.codedError("resident_ceo_peer_ask_failed", "PeerRequest creation did not return a requestId.");
      }
      return { requestId };
    },
    peerReply: async (input) => {
      const outcome = input.outcome ?? "answered";
      const receipt = await bridge.host.run(
        repoId,
        {
          kind: "peer-reply",
          requestId: input.requestId,
          ...(outcome === "answered"
            ? {
                claim: input.claim ?? "Acknowledged.",
                requestedAction: input.requestedAction ?? "Review this update and follow up if needed.",
                ...(input.verification ? { verification: input.verification } : {}),
              }
            : outcome === "rejected"
              ? { outcome: "rejected", reason: input.reason ?? "Rejected by Resident CEO." }
              : { outcome: "done" }),
          idempotencyKey: input.idempotencyKey,
        },
        auth,
      );
      if (receipt.outcome === "applied" || receipt.outcome === "no_changes") {
        return { requestId: input.requestId, outcome };
      }
      throw bridge.codedError(
        receipt.code ?? "resident_ceo_peer_reply_failed",
        receiptFailureMessage(receipt, `Peer reply to ${input.requestId} was rejected.`),
      );
    },
    runtimeSteer: async (input) => {
      if (!bridge.host.steerRuntime) {
        throw bridge.codedError("resident_ceo_runtime_steer_unavailable", "DaemonHost steerRuntime is unavailable.");
      }
      const receipt = await bridge.host.steerRuntime(
        repoId,
        {
          ...(input.runtimeSessionId ? { runtimeSessionId: input.runtimeSessionId } : {}),
          ...(input.dispatchId ? { dispatchId: input.dispatchId } : {}),
          prompt: input.prompt,
          idempotencyKey: input.idempotencyKey,
        },
        auth,
      );
      return {
        runtimeSessionId:
          typeof receipt.runtimeSessionId === "string" ? receipt.runtimeSessionId : (input.runtimeSessionId ?? ""),
        dispatchId: typeof receipt.dispatchId === "string" ? receipt.dispatchId : (input.dispatchId ?? ""),
        opId: typeof receipt.opId === "string" ? receipt.opId : input.idempotencyKey,
      };
    },
    createTask: async (input) => {
      const receipt = await bridge.host.run(
        repoId,
        {
          kind: "task-create",
          title: input.title,
          parentTaskId: input.workId,
          plan: input.plan,
          idempotencyKey: input.idempotencyKey,
        },
        auth,
      );
      if (receipt.outcome !== "applied" && receipt.outcome !== "no_changes") {
        throw bridge.codedError(
          receipt.code ?? "resident_ceo_task_create_failed",
          receiptFailureMessage(receipt, "Task creation was rejected."),
        );
      }
      const parsed = parseReceiptEvidence(receipt.evidence);
      const taskObj =
        parsed?.task && typeof parsed.task === "object" && !Array.isArray(parsed.task)
          ? (parsed.task as { readonly taskId?: unknown })
          : null;
      const taskId =
        typeof taskObj?.taskId === "string"
          ? taskObj.taskId
          : typeof parsed?.taskId === "string"
            ? parsed.taskId
            : null;
      if (taskId === null) {
        throw bridge.codedError("resident_ceo_task_create_failed", "Task creation did not return a taskId.");
      }
      return { taskId };
    },
    startExistingTask: async (input) => {
      const shown = await bridge.host.run(repoId, { kind: "task-show", taskId: input.taskId }, auth);
      if (shown.outcome !== "applied" && shown.outcome !== "no_changes") {
        throw bridge.codedError(
          shown.code ?? "resident_ceo_task_show_failed",
          receiptFailureMessage(shown, `Failed to inspect existing task ${input.taskId}.`),
        );
      }
      const { task, lease } = extractTaskSnapshot(parseReceiptEvidence(shown.evidence));
      if (!task) {
        throw bridge.codedError("task_not_found", `Task ${input.taskId} was not found.`);
      }
      if (task.status !== "planned") {
        throw bridge.codedError(
          "resident_ceo_task_not_planned",
          `start_and_dispatch_existing requires task ${input.taskId} to be planned, but its status is ${String(task.status)}.`,
        );
      }
      requireUnblockedLease(bridge, input.taskId, lease, null, nowIso());
      const localNodeId = bridge.resolveLocalNodeId?.() ?? null;
      const targetNodeId = input.targetNodeId ?? null;
      const isRemoteTargetNode = targetNodeId !== null && targetNodeId !== localNodeId;
      if (isRemoteTargetNode) {
        await assignToNode({
          taskId: input.taskId,
          targetNodeId,
          idempotencyKey: `resident-ceo-assign-existing-${input.idempotencyKey}`,
        });
        return {
          taskId: input.taskId,
          dispatchedTargetNodeId: targetNodeId,
          dispatchRuntimeSessionId: null,
          dispatchError: null,
        };
      }
      const started = await bridge.host.run(repoId, { kind: "task-start", taskId: input.taskId }, auth);
      if (started.outcome !== "applied" && started.outcome !== "no_changes") {
        throw bridge.codedError(
          started.code ?? "resident_ceo_task_start_failed",
          receiptFailureMessage(started, `Failed to start existing planned task ${input.taskId}.`),
        );
      }
      let dispatchRuntimeSessionId: string | null = null;
      let dispatchError: string | null = null;
      if (input.agentId) {
        const [spawned] = await Promise.allSettled([
          bridge.host.spawnRuntime(
            repoId,
            {
              agentId: input.agentId,
              taskId: input.taskId,
              ...(input.runtimeInstanceId ? { runtimeInstanceId: input.runtimeInstanceId } : {}),
              ...(input.model ? { model: input.model } : {}),
              prompt: input.prompt?.trim() || `Execute planned task ${input.taskId}.`,
              dispatchKey: input.dispatchKey,
            },
            auth,
          ),
        ]);
        if (spawned.status === "fulfilled" && typeof spawned.value.runtimeSessionId === "string") {
          dispatchRuntimeSessionId = spawned.value.runtimeSessionId;
        } else if (spawned.status === "rejected") {
          dispatchError = spawned.reason instanceof Error ? spawned.reason.message : String(spawned.reason);
        } else {
          dispatchError = "Controlled agent dispatch did not return a runtime session id.";
        }
      }
      return {
        taskId: input.taskId,
        dispatchedTargetNodeId: null,
        dispatchRuntimeSessionId,
        dispatchError,
      };
    },
    archiveOrCancelUnleased: async (input) => {
      const shown = await bridge.host.run(repoId, { kind: "task-show", taskId: input.taskId }, auth);
      if (shown.outcome !== "applied" && shown.outcome !== "no_changes") {
        throw bridge.codedError(
          shown.code ?? "resident_ceo_task_show_failed",
          receiptFailureMessage(shown, `Failed to inspect task ${input.taskId} before cleanup.`),
        );
      }
      const { task, lease, executions } = extractTaskSnapshot(parseReceiptEvidence(shown.evidence));
      if (!task) {
        throw bridge.codedError("task_not_found", `Task ${input.taskId} was not found.`);
      }
      const { hasOwnExpiredLease } = requireUnblockedLease(
        bridge,
        input.taskId,
        lease,
        input.principalPersonId,
        nowIso(),
      );
      const isTerminal = task.status === "done" || task.status === "cancelled";
      const wantArchive = input.cleanupMode === "archive" || (input.cleanupMode == null && isTerminal);
      if (wantArchive) {
        if (task.packageDisposition === "archived") {
          return { taskId: input.taskId, appliedAction: "archived" };
        }
        const archived = await bridge.host.run(
          repoId,
          {
            kind: "task-archive",
            taskId: input.taskId,
            reason: input.reason,
            idempotencyKey: input.idempotencyKey,
          },
          auth,
        );
        if (archived.outcome !== "applied" && archived.outcome !== "no_changes") {
          throw bridge.codedError(
            archived.code ?? "resident_ceo_archive_failed",
            receiptFailureMessage(archived, `Failed to archive task ${input.taskId}.`),
          );
        }
        return { taskId: input.taskId, appliedAction: "archived" };
      }
      if (task.status === "cancelled") {
        return { taskId: input.taskId, appliedAction: "cancelled" };
      }
      if (task.status === "done") {
        throw bridge.codedError(
          "resident_ceo_invalid_cleanup",
          `Task ${input.taskId} is already done; use cleanupMode="archive" instead of cancel.`,
        );
      }
      if (hasOwnExpiredLease) {
        const released = await bridge.host.run(
          repoId,
          {
            kind: "task-release",
            taskId: input.taskId,
            reason: `Release expired own lease before Resident CEO cleanup: ${input.reason}`,
          },
          auth,
        );
        if (released.outcome !== "applied" && released.outcome !== "no_changes") {
          throw bridge.codedError(
            released.code ?? "resident_ceo_release_failed",
            receiptFailureMessage(released, `Failed to release expired own lease on ${input.taskId}.`),
          );
        }
      }
      const cancelled = await bridge.host.run(
        repoId,
        {
          kind: "task-transition",
          taskId: input.taskId,
          status: "cancelled",
          reason: input.reason,
          ...(executions.length > 0 ? { force: true } : {}),
        },
        auth,
      );
      if (cancelled.outcome !== "applied" && cancelled.outcome !== "no_changes") {
        throw bridge.codedError(
          cancelled.code ?? "resident_ceo_cancel_failed",
          receiptFailureMessage(cancelled, `Failed to cancel unleased task ${input.taskId}.`),
        );
      }
      return { taskId: input.taskId, appliedAction: "cancelled" };
    },
    syncTaskPlan: async (input) => {
      const shown = await bridge.host.run(repoId, { kind: "task-show", taskId: input.taskId }, auth);
      if (shown.outcome !== "applied" && shown.outcome !== "no_changes") {
        throw bridge.codedError(
          shown.code ?? "resident_ceo_task_show_failed",
          receiptFailureMessage(shown, `Failed to inspect task ${input.taskId} before plan sync.`),
        );
      }
      const { task, lease, packagePath } = extractTaskSnapshot(parseReceiptEvidence(shown.evidence));
      if (!task) {
        throw bridge.codedError("task_not_found", `Task ${input.taskId} was not found.`);
      }
      if (task.status !== "planned") {
        throw bridge.codedError(
          "resident_ceo_task_not_planned",
          `doc_sync_plan requires task ${input.taskId} to be planned, but its status is ${String(task.status)}.`,
        );
      }
      requireUnblockedLease(bridge, input.taskId, lease, null, nowIso());
      if (packagePath === null) {
        throw bridge.codedError("resident_ceo_doc_sync_failed", `Task ${input.taskId} has no packagePath.`);
      }
      const rootDir = bridge.resolveRepoRoot?.() ?? null;
      if (rootDir === null) {
        throw bridge.codedError(
          "resident_ceo_doc_sync_failed",
          "Repository root directory is unavailable for doc_sync_plan.",
        );
      }
      const authoredRoot = resolveHarnessLayout(rootDir).authoredRoot;
      const planLogicalPath = `${packagePath}/task_plan.md`;
      const planAbsPath = path.resolve(authoredRoot, ...planLogicalPath.split("/"));
      const rel = path.relative(authoredRoot, planAbsPath);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw bridge.codedError("invalid_field", `Unsafe task_plan.md target path: ${planLogicalPath}.`);
      }
      if (existsSync(planAbsPath) && lstatSync(planAbsPath).isSymbolicLink()) {
        throw bridge.codedError("invalid_field", `Refusing to write symbolic link ${planLogicalPath}.`);
      }
      const normalizedBody = input.planContent.endsWith("\n") ? input.planContent : `${input.planContent}\n`;
      writeFileDurably(planAbsPath, normalizedBody);
      const submitted = await bridge.host.run(repoId, { kind: "doc-submit", paths: [planLogicalPath] }, auth);
      if (submitted.outcome !== "applied" && submitted.outcome !== "no_changes") {
        throw bridge.codedError(
          submitted.code ?? "resident_ceo_doc_sync_failed",
          receiptFailureMessage(submitted, `doc-submit failed for ${planLogicalPath}.`),
        );
      }
      return { taskId: input.taskId, path: planLogicalPath };
    },
  };
}

interface ResidentCeoTurnActionServicePort {
  readonly executeTier0Action: (input: ResidentCeoTier0ActionInput) => Promise<ResidentCeoActionReceipt>;
  readonly recordProposal: (draft: ResidentCeoProposalDraft) => Promise<{
    readonly proposal: {
      readonly proposalId: string;
      readonly actionKind?: string;
      readonly status: string;
      readonly approvalMode: ResidentCeoActionReceipt["approvalMode"];
      readonly promotedTaskId: string | null;
      readonly targetTaskId?: string | null;
      readonly dispatchRuntimeSessionId: string | null;
      readonly dispatchError: string | null;
    };
    readonly autoApproved: boolean;
    readonly errorCode?: string | null;
  }>;
  readonly recordTier2Rejection: (input: {
    readonly wakeId: string;
    readonly channel: "human-chat" | "peer-request" | "heartbeat";
    readonly actorPersonId: string;
    readonly rawAction: string;
    readonly rationale: string;
  }) => Promise<ResidentCeoActionReceipt>;
  readonly recordDeniedAction: (input: {
    readonly wakeId: string;
    readonly channel: "human-chat" | "peer-request" | "heartbeat";
    readonly tier: "tier0" | "tier1" | "tier2";
    readonly actionKind: string;
    readonly actorPersonId: string;
    readonly errorCode: string;
    readonly detail: string;
    readonly targetRef?: string | null;
  }) => Promise<ResidentCeoActionReceipt>;
}

function extractOwnerMessage(prompt: string): string {
  const marker = "\nOwner message:\n";
  const index = prompt.lastIndexOf(marker);
  return index >= 0 ? prompt.slice(index + marker.length).trim() : prompt.trim();
}

export async function settleResidentCeoHumanChatTurn(input: {
  readonly profile: ResidentCeoProfile;
  readonly principalPersonId: string;
  readonly wakeId: string;
  readonly userMessage: string;
  readonly response: string;
  readonly service: ResidentCeoTurnActionServicePort;
}): Promise<{ readonly response: string; readonly actionReceipts: readonly ResidentCeoActionReceipt[] }> {
  if (effectiveResidentCeoExecutionPolicy(input.profile) !== "approval-gated") {
    return { response: input.response, actionReceipts: [] };
  }
  const cleanUserMessage = extractOwnerMessage(input.userMessage);
  const parsed = parseResidentCeoTurnActions(input.response, {
    channel: "human-chat",
    fallbackToProposeTask: false,
    fallback: {
      summary: cleanUserMessage,
      defaultWorkId: input.profile.defaultWorkId ?? null,
      defaultAgentId: input.profile.defaultAgentId ?? null,
      requestedAction: cleanUserMessage,
    },
  });
  if (parsed.mode === "reply_only" || parsed.mode === "advise_only") {
    return { response: parsed.replyText, actionReceipts: [] };
  }
  const receipts: ResidentCeoActionReceipt[] = [];
  let tier0Count = 0;
  for (let index = 0; index < parsed.actions.length; index += 1) {
    const action = parsed.actions[index]!;
    if (action.tier === "tier2") {
      receipts.push(
        await input.service.recordTier2Rejection({
          wakeId: input.wakeId,
          channel: "human-chat",
          actorPersonId: input.principalPersonId,
          rawAction: action.rawAction,
          rationale: action.rationale,
        }),
      );
      continue;
    }
    if (action.tier === "rejected") {
      receipts.push(
        await input.service.recordDeniedAction({
          wakeId: input.wakeId,
          channel: "human-chat",
          tier: "tier1",
          actionKind: action.rawAction || "unknown",
          actorPersonId: input.principalPersonId,
          errorCode: action.errorCode,
          detail: action.reason,
        }),
      );
      continue;
    }
    if (action.tier === "tier0") {
      if (tier0Count >= RESIDENT_CEO_MAX_TIER0_ACTIONS_PER_TURN) {
        receipts.push(
          await input.service.recordDeniedAction({
            wakeId: input.wakeId,
            channel: "human-chat",
            tier: "tier0",
            actionKind: action.actionKind,
            actorPersonId: input.principalPersonId,
            errorCode: "resident_ceo_tier0_limit_exceeded",
            detail: `Tier 0 action ${action.actionKind} exceeded per-turn limit (${RESIDENT_CEO_MAX_TIER0_ACTIONS_PER_TURN}).`,
          }),
        );
        continue;
      }
      tier0Count += 1;
      receipts.push(
        await input.service.executeTier0Action({
          wakeId: input.wakeId,
          channel: "human-chat",
          actorPersonId: input.principalPersonId,
          targetPersonId: action.actionKind === "peer_ask" ? action.toPersonId : null,
          action,
        }),
      );
      continue;
    }
    // Tier 1 action -> owner-direct via recordProposal
    const syntheticPeerId = `human-chat:${input.wakeId}:${index}`;
    const recorded = await input.service.recordProposal({
      peerRequestId: syntheticPeerId,
      fromPersonId: input.principalPersonId,
      summary: cleanUserMessage,
      actionKind: action.actionKind,
      sourceChannel: "human-chat",
      targetTaskId: action.actionKind === "promote_and_dispatch" ? null : action.targetTaskId,
      cleanupMode: action.actionKind === "archive_or_cancel_unleased" ? action.cleanupMode : null,
      planContent: action.actionKind === "doc_sync_plan" ? action.planContent : null,
      proposedTitle: action.proposedTitle,
      proposedWorkId:
        action.actionKind === "promote_and_dispatch" ? action.proposedWorkId : (input.profile.defaultWorkId ?? null),
      proposedAgentId:
        action.actionKind === "promote_and_dispatch" || action.actionKind === "start_and_dispatch_existing"
          ? action.proposedAgentId
          : null,
      proposedTargetNodeId:
        action.actionKind === "promote_and_dispatch" || action.actionKind === "start_and_dispatch_existing"
          ? action.proposedTargetNodeId
          : null,
      proposedPrompt:
        action.actionKind === "promote_and_dispatch" || action.actionKind === "start_and_dispatch_existing"
          ? action.proposedPrompt
          : null,
      rationale: action.rationale,
      wakeId: input.wakeId,
    });
    const outcome =
      recorded.proposal.status === "promoted"
        ? "executed"
        : recorded.proposal.status === "failed"
          ? "denied"
          : "proposed";
    receipts.push({
      tier: "tier1",
      actionKind: action.actionKind,
      outcome,
      approvalMode: recorded.proposal.approvalMode,
      targetRef: recorded.proposal.targetTaskId ?? recorded.proposal.promotedTaskId ?? null,
      resultRef: recorded.proposal.promotedTaskId,
      proposalId: recorded.proposal.proposalId,
      taskId: recorded.proposal.promotedTaskId,
      runtimeSessionId: recorded.proposal.dispatchRuntimeSessionId,
      errorCode: recorded.errorCode ?? null,
      detail:
        recorded.proposal.dispatchError ??
        `${action.actionKind} (${recorded.proposal.status}${recorded.proposal.promotedTaskId ? ` -> ${recorded.proposal.promotedTaskId}` : ""})`,
    });
  }
  const summaryLines = receipts.map((item) => {
    const refPart = item.requestId
      ? ` requestId=${item.requestId}`
      : item.taskId
        ? ` taskId=${item.taskId}`
        : item.resultRef
          ? ` ref=${item.resultRef}`
          : "";
    const errPart = item.errorCode ? ` error=${item.errorCode}` : "";
    return `[${item.tier}:${item.actionKind}] ${item.outcome}${refPart}${errPart} — ${item.detail}`;
  });
  const baseReply = parsed.replyText?.trim() ?? "";
  const combinedResponse = baseReply.length > 0 ? `${baseReply}\n${summaryLines.join("\n")}` : summaryLines.join("\n");
  return { response: combinedResponse || input.response, actionReceipts: receipts };
}
