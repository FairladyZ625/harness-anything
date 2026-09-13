import path from "node:path";
import { localUserDaemonEndpoint, resolveLocalDaemonTarget } from "../../../daemon/src/client/local-daemon-target.ts";
import { requestDaemonJsonRpcAt } from "../../../daemon/src/client/local-json-rpc-client.ts";
import { readDaemonStoppedAt } from "../../../daemon/src/client/daemon-autostart.ts";
import { readDaemonLifecycleRecords } from "../../../daemon/src/lifecycle-log.ts";
import { consumeKnownError } from "./client.ts";
import { daemonFailure, daemonOption } from "./control-support.ts";

export async function status(
  userRoot: string,
  daemonId: string,
  argv: readonly string[] = [],
): Promise<Record<string, unknown>> {
  const root = path.resolve(daemonOption(argv, "--root") ?? process.cwd()),
    repoIdOverride = daemonOption(argv, "--repo") ?? process.env.HARNESS_DAEMON_REPO_ID;
  // Same resolver as every command: canonicalised registry match, and the injected-endpoint
  // conflict check fails closed here too.
  let resolved: Awaited<ReturnType<typeof resolveLocalDaemonTarget>> | null;
  try {
    resolved = await resolveLocalDaemonTarget({ rootDir: root, repoIdOverride, userRoot, daemonId });
  } catch (error) {
    if ((error as { readonly code?: unknown }).code === "daemon_target_conflict") throw error;
    consumeKnownError(error);
    resolved = null;
  }
  const endpoint = resolved?.socketPath ?? localUserDaemonEndpoint(userRoot, daemonId);
  let result: Record<string, unknown>;
  try {
    result = await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 75, undefined, undefined, true);
  } catch (error) {
    const stoppedAt = readDaemonStoppedAt(userRoot, daemonId);
    if (stoppedAt) {
      consumeKnownError(error);
      const summary = `daemon status: not running (stopped by operator at ${stoppedAt})`;
      result = { ...daemonFailure("daemon-status", "daemon_unavailable", summary), summary };
    } else {
      const exit = lastDaemonLifecycleExit(userRoot, daemonId);
      if (!exit) throw error;
      consumeKnownError(error);
      const summary = `daemon status: not running (exited ${exit.outcome} at ${exit.at})`;
      result = {
        ...daemonFailure(
          "daemon-status",
          "daemon_unavailable",
          "The next command will autostart the daemon from the current disk build; " +
            "run `ha daemon start --service` to start it explicitly.",
        ),
        summary,
      };
    }
  }
  const target = {
      endpoint,
      daemonId,
      userRoot,
      repoId: resolved?.repoId ?? null,
      canonicalRoot: resolved?.canonicalRoot ?? null,
    },
    detail =
      `target: endpoint=${endpoint} daemonId=${daemonId} userRoot=${userRoot} ` +
      `repoId=${target.repoId ?? "none"} canonicalRoot=${target.canonicalRoot ?? "none"}`;
  return { ...result, target, summary: `${String(result.summary ?? "daemon status")}\n${detail}` };
}
// A daemon that self-exited (build_superseded, a signalled stop, a failed startup) leaves no operator
// stop marker, so its own account in the lifecycle log is the only record of why it is gone. Only the
// log's final record qualifies: a trailing process_start belongs to a daemon that died before it could
// record anything, and speaking an older exit for it would misreport the current generation.
function lastDaemonLifecycleExit(
  userRoot: string,
  daemonId: string,
): { readonly outcome: string; readonly at: string } | null {
  const exit = readDaemonLifecycleRecords(userRoot, daemonId).at(-1);
  return exit?.event === "process_exit" && typeof exit.outcome === "string"
    ? { outcome: exit.outcome, at: exit.at }
    : null;
}

export function assessDaemonStatus(result: Record<string, unknown>): {
  readonly receipt: Record<string, unknown>;
  readonly exitCode: 0 | 1;
} {
  // A status that could not reach a daemon (including the operator-stop report) exits non-zero like every
  // other unavailable answer; callers such as the first-run lane poll on that exit code.
  if (result.ok === false) return { receipt: result, exitCode: 1 };
  const rows = Array.isArray(result.repos) ? result.repos : [],
    retryingRows = rows.flatMap((value) => {
      if (!statusRecord(value) || !statusRecord(value.materialization)) return [];
      const health = value.materialization;
      if (
        health.state !== "retrying" ||
        typeof value.repoId !== "string" ||
        !Number.isSafeInteger(health.lastCheckpointRevision) ||
        !Number.isSafeInteger(health.pendingWalEvents) ||
        !Number.isSafeInteger(health.retryElapsedMs) ||
        typeof health.lastError !== "string"
      )
        return [];
      return [
        `repo=${value.repoId} state=retrying waitedMs=${String(health.retryElapsedMs)} ` +
          `lastCheckpointRevision=${String(health.lastCheckpointRevision)} ` +
          `pendingWalEvents=${String(health.pendingWalEvents)} ` +
          `lastError=${health.lastError.replace(/\s+/gu, " ").trim()}`,
      ];
    }),
    assessedResult =
      retryingRows.length === 0
        ? result
        : {
            ...result,
            summary:
              `${String(result.summary ?? "daemon status")}\n` +
              `SQLite-to-Git publication retrying: ${retryingRows.join("; ")}`,
          },
    failedRows = rows.filter(
      (value) => statusRecord(value) && statusRecord(value.materialization) && value.materialization.state === "failed",
    ),
    failures = failedRows.flatMap((value) => {
      if (!statusRecord(value) || !statusRecord(value.materialization)) return [];
      const health = value.materialization;
      if (
        typeof value.repoId !== "string" ||
        !Number.isSafeInteger(health.lastCheckpointRevision) ||
        Number(health.lastCheckpointRevision) < 0 ||
        !Number.isSafeInteger(health.pendingWalEvents) ||
        Number(health.pendingWalEvents) < 0 ||
        (health.lastCheckpointAt !== null && typeof health.lastCheckpointAt !== "string") ||
        (health.reason !== "git_diverged" &&
          health.reason !== "deterministic_failure" &&
          health.reason !== "retry_budget_exhausted") ||
        typeof health.lastError !== "string"
      )
        return [];
      return [
        {
          repoId: value.repoId,
          lastCheckpointRevision: health.lastCheckpointRevision as number,
          lastCheckpointAt: typeof health.lastCheckpointAt === "string" ? health.lastCheckpointAt : null,
          pendingWalEvents: health.pendingWalEvents as number,
          reason: health.reason as "git_diverged" | "deterministic_failure" | "retry_budget_exhausted",
          lastError: health.lastError,
        },
      ];
    });
  if (failedRows.length === 0) return { receipt: assessedResult, exitCode: 0 };
  const first = failures[0],
    details = failedRows
      .map((value) => {
        if (!statusRecord(value) || !statusRecord(value.materialization))
          return "repo=unknown state=failed details=malformed";
        const health = value.materialization;
        return (
          `repo=${String(value.repoId ?? "unknown")} state=failed reason=${String(health.reason ?? "unknown")} ` +
          `lastCheckpointRevision=${String(health.lastCheckpointRevision ?? "unknown")} ` +
          `lastCheckpointAt=${String(health.lastCheckpointAt ?? "none")} ` +
          `pendingWalEvents=${String(health.pendingWalEvents ?? "unknown")} ` +
          `lastError=${String(health.lastError ?? "missing")}`
        );
      })
      .join("; "),
    hint =
      `SQLite-to-Git publication failed: ${details}. Repair the reported cause, then use the existing ` +
      "repository recovery path. Accepted commands remain durable in SQLite; query their operation ids.";
  return {
    exitCode: 1,
    receipt: {
      ...assessedResult,
      ok: false,
      outcome: "op_rejected",
      code: "materialization_failed",
      origin: "cli",
      evidence: `materialization-failed:${failedRows
        .map((value) => (statusRecord(value) ? String(value.repoId ?? "unknown") : "unknown"))
        .join(",")}`,
      nextAction: hint,
      error: { code: "materialization_failed", hint },
      ...(first ? { diagnostic: { kind: "materialization-failed", ...withoutRepoId(first) } } : {}),
    },
  };
}

function withoutRepoId(failure: {
  readonly repoId: string;
  readonly lastCheckpointRevision: number;
  readonly lastCheckpointAt: string | null;
  readonly pendingWalEvents: number;
  readonly reason: "git_diverged" | "deterministic_failure" | "retry_budget_exhausted";
  readonly lastError: string;
}) {
  const { repoId: _repoId, ...diagnostic } = failure;
  return diagnostic;
}

function statusRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
