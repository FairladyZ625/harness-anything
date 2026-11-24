import path from "node:path";
import { readDaemonRegistry } from "@harness-anything/kernel";
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
 *   (resolves trusted candidate targets from `<userRoot>/fleet/center-switchover-candidates/<repoId>/<nodeId>.json`
 *   so dry-run preflight, live switchover, and audited rollback stay bound to the same target host)
 * - `promoteFromEdge`: delegates to `relocateFleetCenter(["fleet", "center", "promote-from-edge", ...])`
 *   with `--stop-edge-daemon --switch-to-local` so an active desktop edge daemon drains safely before promotion
 * - `edgeLocalState`: purely local read via `readFleetEdgeLocalState` (never dials an unreachable center)
 *
 * Host paths (`root`, `userRoot`, `stateRoot`) are always resolved from the local registry in main,
 * never accepted from the renderer. Coded errors propagate through `withIpcDomainErrors(ipcMain)`.
 */
export function createCenterSwitchPort(options: CenterSwitchPortOptions) {
  const resolveDaemonId = (): string => options.daemonId?.() ?? daemonIdFromEnv();
  const resolveCanonicalRoot = (
    repoId: string,
  ): { readonly canonicalRoot: string; readonly userRoot: string } | null => {
    const userRoot = path.resolve(options.userRoot());
    const repo = readDaemonRegistry({ userRoot }).repos.find(
      (entry) => entry.repoId === repoId && entry.mode !== "remote-proxy" && entry.canonicalRoot !== null,
    );
    if (!repo || repo.canonicalRoot === null) return null;
    return { canonicalRoot: repo.canonicalRoot, userRoot };
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
      const resolved = resolveCanonicalRoot(input.repoId);
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
      const resolved = resolveCanonicalRoot(input.repoId);
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
    },

    edgeLocalState: async (repoId: string): Promise<JsonObject> => {
      return readFleetEdgeLocalState({ userRoot: options.userRoot(), repoId }) as unknown as JsonObject;
    },
  };
}
