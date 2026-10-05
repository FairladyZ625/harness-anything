import { getExecutableEntityAction, type DaemonRepoMode, type WriteSource } from "@harness-anything/kernel";
import type { CommandTopology } from "@harness-anything/preset/internal/preset-command-contract";

export interface RepoModeAdmission {
  readonly ok: boolean;
  readonly code: string;
  readonly nextAction: string;
}
export function repoModeAdmission(ok: boolean, code: string): RepoModeAdmission {
  const nextAction = code;
  return { ok, code, nextAction };
}
const rejection = (code: string): RepoModeAdmission => repoModeAdmission(false, code);

/** Resolve field-scoped local effects declared by an executable Entity Action contract. */
export function entityActionCommandTopology(
  command: CommandTopology,
  action: Readonly<Record<string, unknown>> & { readonly kind?: string },
): CommandTopology {
  const localOnlyFields = action.kind ? (getExecutableEntityAction(action.kind)?.execution?.localOnlyFields ?? []) : [],
    mutationFields = Object.keys(action).filter(
      (field) => !["kind", "idempotencyKey", "expectedVersion"].includes(field),
    );
  if (mutationFields.length === 0 || mutationFields.some((field) => !localOnlyFields.includes(field))) return command;
  return {
    ...command,
    admission: {
      local: "direct",
      "remote-proxy": "rejected",
      "remote-center": "direct",
      "remote-edge": "direct",
    },
  };
}

/**
 * A builtin occurrence executes on the node holding the canonical cell, so on a center its
 * trigger half is the center's own instead of an edge assignment's. Only the cell resolves this:
 * host admission keeps the declared route, so the entrance serves the daemon's own scheduler and
 * no transport source.
 */
export function builtinOccurrenceCommandTopology(command: CommandTopology, builtinTarget: boolean): CommandTopology {
  if (!builtinTarget || command.admission["remote-center"] !== "via-node") return command;
  return { ...command, admission: { ...command.admission, "remote-center": "direct" } };
}

export function admitRepoMode(
  mode: DaemonRepoMode,
  command: Pick<CommandTopology, "admission">,
  source: WriteSource,
): RepoModeAdmission {
  if (mode === "remote-proxy") return rejection("repo_mode_remote_proxy");
  const route = command.admission[mode],
    node = typeof source === "object" && source.kind === "node";
  if (mode === "local" && source === "remote_direct") return rejection("repo_mode_rejects_direct_remote");
  if (route === "direct" && !(mode === "remote-edge" && node)) return repoModeAdmission(true, "repo_mode_admitted");
  if (route === "via-node" && node) return repoModeAdmission(true, "repo_mode_admitted");
  if (route === "via-node") return rejection("repo_mode_requires_center_ingress");
  if (route === "via-center-forward") return rejection("repo_mode_read_only");
  // The edge CLI answers these from the replica; the daemon's own projection on an edge is not the ledger.
  if (route === "edge-replica") return rejection("repo_mode_read_only");
  if (mode === "remote-edge") return rejection("repo_mode_read_only");
  return rejection("repo_mode_command_rejected");
}
