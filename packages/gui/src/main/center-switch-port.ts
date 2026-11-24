import { existsSync } from "node:fs";
import path from "node:path";
import { readDaemonRegistry, type DaemonRepoMode } from "@harness-anything/kernel";
import type { JsonObject } from "@harness-anything/daemon";
import { daemonIdFromEnv } from "@harness-anything/daemon/client";
import { readFleetEdgeLocalState, relocateFleetCenter } from "@harness-anything/daemon/internal/fleet/center";
import type { CenterSwitchInput, PromoteFromEdgeInput } from "../api/center-settings-contract.ts";

export interface CenterSwitchPortOptions {
  readonly userRoot: () => string;
  readonly readOnly: () => boolean;
  readonly daemonId?: () => string;
}

/**
 * Main-process bridge for Switchover v1 Slice 3 operations:
 * - `centerSwitch`: delegates to `relocateFleetCenter(["fleet", "center", "switch", ...])`
 *   (resolves trusted remote candidate metadata from `<userRoot>/fleet/center-switchover-candidates/<repoId>/<nodeId>.json`
 *   for preflight/execution and immutable Phase 1 fence authority for audited rollback)
 * - `promoteFromEdge`: enforces remote-edge mode, promotion-audit absence, and per-repo concurrency mutex
 *   before invoking `relocateFleetCenter(["fleet", "center", "promote-from-edge", ...])`
 * - `edgeLocalState`: purely local read via `readFleetEdgeLocalState` (never dials an unreachable center)
 *
 * Host paths (`root`, `userRoot`, `stateRoot`) are always resolved from the local registry in main,
 * never accepted from the renderer. Coded errors propagate through `withIpcDomainErrors(ipcMain)`.
 */
export function createCenterSwitchPort(options: CenterSwitchPortOptions) {
  const resolveDaemonId = (): string => options.daemonId?.() ?? daemonIdFromEnv();
  const inFlightPromotions = new Map<string, boolean>();
  const resolveRegisteredRepo = (
    repoId: string,
  ): { readonly canonicalRoot: string; readonly userRoot: string; readonly mode: DaemonRepoMode } | null => {
    const userRoot = path.resolve(options.userRoot());
    const repo = readDaemonRegistry({ userRoot }).repos.find(
      (entry) => entry.repoId === repoId && entry.mode !== "remote-proxy" && entry.canonicalRoot !== null,
    );
    if (!repo || repo.canonicalRoot === null) return null;
    return { canonicalRoot: repo.canonicalRoot, userRoot, mode: repo.mode };
  };

  return {
    centerSwitch: async (input: CenterSwitchInput): Promise<JsonObject> => {
      const isMutation = input.abortRollback === true || input.dryRun !== true;
      if (isMutation && options.readOnly()) {
        return {
          ok: false,
          code: "gui_read_only",
          error: { code: "gui_read_only", hint: "GUI read-only daemon attachment rejects write operations." },
        };
      }
      const resolved = resolveRegisteredRepo(input.repoId);
      if (!resolved) {
        return {
          ok: false,
          code: "repo_namespace_unknown",
          error: {
            code: "repo_namespace_unknown",
            hint: `Repository ${input.repoId} has no registered local canonical root on this host.`,
          },
        };
      }
      const stateRoot = path.join(resolved.userRoot, "fleet");
      const daemonId = resolveDaemonId();
      const argv: string[] =
        input.abortRollback === true
          ? [
              "fleet",
              "center",
              "switch",
              "--abort-rollback",
              "--root",
              resolved.canonicalRoot,
              "--repo",
              input.repoId,
              "--user-root",
              resolved.userRoot,
              "--state-root",
              stateRoot,
              "--daemon-id",
              daemonId,
              "--switchover-id",
              input.switchoverId,
              "--reason",
              input.reason,
            ]
          : [
              "fleet",
              "center",
              "switch",
              "--root",
              resolved.canonicalRoot,
              "--repo",
              input.repoId,
              "--user-root",
              resolved.userRoot,
              "--state-root",
              stateRoot,
              "--daemon-id",
              daemonId,
              "--to",
              input.targetNodeId,
              ...(input.dryRun ? ["--dry-run"] : []),
              ...(input.switchoverId ? ["--switchover-id", input.switchoverId] : []),
              ...(input.targetExternalUrl ? ["--target-external-url", input.targetExternalUrl] : []),
              ...(input.targetLoginUrl ? ["--target-login-url", input.targetLoginUrl] : []),
              ...(input.targetSpkiSha256 ? ["--target-spki-sha256", input.targetSpkiSha256] : []),
            ];
      const outcome = await relocateFleetCenter(argv, resolved.userRoot);
      return outcome.receipt as JsonObject;
    },

    promoteFromEdge: async (input: PromoteFromEdgeInput): Promise<JsonObject> => {
      if (options.readOnly()) {
        return {
          ok: false,
          code: "gui_read_only",
          error: { code: "gui_read_only", hint: "GUI read-only daemon attachment rejects write operations." },
        };
      }
      const resolved = resolveRegisteredRepo(input.repoId);
      if (!resolved) {
        return {
          ok: false,
          code: "repo_namespace_unknown",
          error: {
            code: "repo_namespace_unknown",
            hint: `Repository ${input.repoId} has no registered local canonical root on this host.`,
          },
        };
      }
      const stateRoot = path.join(resolved.userRoot, "fleet");
      const mutexKey = `${resolved.userRoot}\0${input.repoId}`;
      if (inFlightPromotions.get(mutexKey) === true) {
        return {
          ok: false,
          code: "promotion_in_progress",
          error: {
            code: "promotion_in_progress",
            hint: `Break-glass promotion is already running for ${input.repoId}.`,
          },
        };
      }
      if (resolved.mode !== "remote-edge") {
        return {
          ok: false,
          code: "repo_not_remote_edge",
          error: {
            code: "repo_not_remote_edge",
            hint: `Repository ${input.repoId} is registered in mode ${resolved.mode}, not remote-edge.`,
          },
        };
      }
      const auditPath = path.join(stateRoot, "governance", "center-emergency-promoted", `${input.repoId}.json`);
      if (existsSync(auditPath)) {
        return {
          ok: false,
          code: "already_promoted",
          error: {
            code: "already_promoted",
            hint: `An emergency promotion record already exists for ${input.repoId}.`,
          },
        };
      }
      inFlightPromotions.set(mutexKey, true);
      try {
        const daemonId = resolveDaemonId();
        const argv: string[] = [
          "fleet",
          "center",
          "promote-from-edge",
          "--root",
          resolved.canonicalRoot,
          "--repo",
          input.repoId,
          "--user-root",
          resolved.userRoot,
          "--state-root",
          stateRoot,
          "--daemon-id",
          daemonId,
          "--force-new-epoch",
          "--confirm-possible-tail-loss",
          "--stop-edge-daemon",
          "--switch-to-local",
          ...(input.rbacBackupStatus ? ["--rbac-backup-status", input.rbacBackupStatus] : []),
        ];
        const outcome = await relocateFleetCenter(argv, resolved.userRoot);
        return outcome.receipt as JsonObject;
      } finally {
        inFlightPromotions.set(mutexKey, false);
      }
    },

    edgeLocalState: async (repoId: string): Promise<JsonObject> => {
      return readFleetEdgeLocalState({ userRoot: options.userRoot(), repoId }) as unknown as JsonObject;
    },
  };
}
