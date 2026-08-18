import type { DaemonRepoMode, WriteSource } from "../../kernel/src/index.ts";
import type { DaemonCommandClass } from "./identity/types.ts";

export interface RepoModeAdmission { readonly ok: boolean; readonly code: string; readonly nextAction: string }

export function admitRepoMode(mode: DaemonRepoMode, commandClass: DaemonCommandClass, source: WriteSource): RepoModeAdmission {
  const assignment = typeof source === "object" && source.kind === "assignment";
  const directRemote = source === "remote_direct";
  const allowed = mode === "local"
    ? !directRemote
    : mode === "remote-center"
      ? commandClass === "repo-read" || assignment && commandClass === "repo-write"
      : commandClass === "repo-read" && !assignment;
  if (allowed) return { ok: true, code: "repo_mode_admitted", nextAction: "Continue." };
  if (mode === "remote-center") return { ok: false, code: "repo_mode_requires_center_ingress", nextAction: "Send write commands through the authenticated Fleet assignment ingress; local direct writes are disabled for remote-center repositories." };
  if (mode === "remote-edge") return { ok: false, code: "repo_mode_read_only", nextAction: "Send writes to the remote center; this remote-edge repository only serves local reads and receipt queries." };
  return { ok: false, code: "repo_mode_rejects_direct_remote", nextAction: "Use authenticated assignment ingress for remote commands; direct remote writes are not admitted." };
}
