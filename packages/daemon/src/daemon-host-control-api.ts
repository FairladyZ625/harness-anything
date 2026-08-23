import { randomUUID } from "node:crypto";
import { readDaemonRegistry } from "../../kernel/src/index.ts";
import type { DaemonHost } from "./daemon-host.ts";
import type { DaemonControlReceipt } from "./gui-s3-control.ts";

export function createDaemonHostControlApi(
  context: any,
): Pick<
  DaemonHost,
  "requestControl" | "controlReceipt" | "issueRuntimeWitness" | "bindRuntimeWitness" | "publishRuntimeWitness"
> {
  return {
    requestControl: async (payload, auth) => {
      context.localOnly(auth);
      const authorityRepoId = context.requiredText(payload.authorityRepoId, "authorityRepoId"),
        repo = readDaemonRegistry({ userRoot: context.input.userRoot }).repos.find(
          (entry) => entry.repoId === authorityRepoId,
        );
      if (!repo) throw context.hostCodedError("repo_namespace_unknown", `Unknown authority repo: ${authorityRepoId}.`);
      await context.binding(repo.canonicalRoot, auth, "admin");
      const kind = payload.kind;
      if (kind !== "refresh" && kind !== "restart")
        throw context.hostCodedError("invalid_control", "kind must be refresh or restart.");
      const requestedAt = new Date().toISOString(),
        operationId = `daemon-control-${randomUUID()}`,
        before = context.point();
      if (kind === "restart") {
        const rejectedReceipt: DaemonControlReceipt = {
          schema: "daemon-control-receipt/v1",
          ok: false,
          outcome: "op_rejected",
          kind,
          operationId,
          phase: "failed",
          requestedAt,
          completedAt: requestedAt,
          before,
          after: null,
          error: {
            code: "supervisor_required",
            hint: "Electron main must own restart and its receipt.",
          },
          nextAction: "Request restart through the local Electron supervisor.",
        };
        context.controls.set(operationId, rejectedReceipt);
        context.latestControl = rejectedReceipt;
        return rejectedReceipt;
      }
      if (
        context.latestControl?.phase === "queued" ||
        context.latestControl?.phase === "draining" ||
        context.latestControl?.phase === "starting"
      ) {
        const busy: DaemonControlReceipt = {
          schema: "daemon-control-receipt/v1",
          ok: false,
          outcome: "op_rejected",
          kind,
          operationId,
          phase: "failed",
          requestedAt,
          completedAt: requestedAt,
          before,
          after: null,
          error: {
            code: "control_busy",
            hint: `Wait for ${context.latestControl.operationId}.`,
          },
          nextAction: `Poll ${context.latestControl.operationId}.`,
        };
        context.controls.set(operationId, busy);
        return busy;
      }
      const pending: DaemonControlReceipt = {
        schema: "daemon-control-receipt/v1",
        ok: true,
        outcome: "pending",
        kind,
        operationId,
        phase: "queued",
        requestedAt,
        completedAt: null,
        before,
        after: null,
        error: null,
        nextAction: `Poll ${operationId}.`,
      };
      context.controls.set(operationId, pending);
      context.latestControl = pending;
      void context.refreshRegistry().then(
        () => context.settleControl(pending, true),
        (error: unknown) => context.settleControl(pending, false, error),
      );
      return pending;
    },
    controlReceipt: (operationId, auth) => {
      context.localOnly(auth);
      const receipt = context.controls.get(operationId);
      if (receipt) return receipt;
      const now = new Date().toISOString();
      return {
        schema: "daemon-control-receipt/v1",
        ok: false,
        outcome: "op_rejected",
        kind: "refresh",
        operationId,
        phase: "failed",
        requestedAt: now,
        completedAt: now,
        before: null,
        after: null,
        error: {
          code: "operation_not_found",
          hint: "No daemon control receipt exists for this operationId.",
        },
        nextAction: null,
      };
    },
    issueRuntimeWitness: async (repoId, runtimeSessionId, auth) => {
      context.requireHostMode(repoId, "repo-write", auth);
      await context.attemptHostRecovery(repoId);
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId),
        serverBinding = await context.binding(cell.status().rootDir, auth, "repo-write");
      if (serverBinding.roles?.some((role: string) => role === "$admin" || role === "$arbiter"))
        throw context.hostCodedError("rbac_forbidden", "Admin and arbiter identities cannot become runtime witnesses.");
      return cell.runtime.issueWitnessToken(runtimeSessionId, {
        principalId: serverBinding.actor.principal.personId,
        source: serverBinding.source,
      });
    },
    bindRuntimeWitness: (repoId, token) =>
      context.requiredCell(context.cells, context.warming, context.unavailable, repoId).runtime.bindWitness(token),
    publishRuntimeWitness: (repoId, token, signal) => {
      const cell = context.requiredCell(context.cells, context.warming, context.unavailable, repoId),
        witness = cell.runtime.bindWitness(token);
      return cell.runtime.publish(witness.runtimeSessionId, signal);
    },
  };
}
