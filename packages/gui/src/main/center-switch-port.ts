import path from "node:path";
import { readDaemonRegistry } from "@harness-anything/kernel";
import type { JsonObject } from "@harness-anything/daemon";
import { readFleetEdgeLocalState, relocateFleetCenter } from "@harness-anything/daemon/internal/fleet/center";
import type { CenterSwitchInput, PromoteFromEdgeInput } from "../api/center-settings-contract.ts";

export interface CenterSwitchPortOptions {
  readonly userRoot: () => string;
  readonly readOnly: () => boolean;
}

/**
 * Main-process bridge for Switchover v1 Slice 3 operations:
 * - `centerSwitch`: delegates to `relocateFleetCenter(["fleet", "center", "switch", ...])`
 * - `promoteFromEdge`: delegates to `relocateFleetCenter(["fleet", "center", "promote-from-edge", ...])`
 * - `edgeLocalState`: purely local read via `readFleetEdgeLocalState` (never dials an unreachable center)
 *
 * Host paths (`root`, `userRoot`, `stateRoot`) are always resolved from the local registry in main,
 * never accepted from the renderer. Coded errors propagate through `withIpcDomainErrors(ipcMain)`.
 */
export function createCenterSwitchPort(options: CenterSwitchPortOptions) {
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
        "--force-new-epoch",
        "--confirm-possible-tail-loss",
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
