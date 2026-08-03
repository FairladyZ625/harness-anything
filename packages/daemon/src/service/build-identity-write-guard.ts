import type { DaemonLogService } from "@harness-anything/application";
import type { DaemonRepoNamespace } from "../protocol/json-rpc-server.ts";
import type { MultiRepoHarnessDaemonRuntime } from "../runtime/repo-runtime.ts";
import {
  createDaemonBuildIdentityWitness,
  type DaemonBuildIdentityWitness,
  type DaemonDeploymentStatusBuild
} from "./deployment-status-options.ts";

export function installDaemonBuildWriteGuard(input: {
  readonly runtime: MultiRepoHarnessDaemonRuntime;
  readonly repos: ReadonlyArray<DaemonRepoNamespace>;
  readonly defaultRepoId: string;
  readonly build: DaemonDeploymentStatusBuild;
  readonly daemonLogService: DaemonLogService;
}): DaemonBuildIdentityWitness {
  const witness = createDaemonBuildIdentityWitness(input.build, {
    onBlocked: (diagnostic) => {
      const repo = input.repos.find((candidate) => candidate.repoId === input.defaultRepoId)
        ?? input.repos[0];
      if (!repo) return;
      void input.daemonLogService.append({
        level: "error",
        source: "daemon",
        component: "build-identity",
        event: "mixed-version-writes-blocked",
        message: diagnostic.message,
        errorCode: diagnostic.code,
        hint: "Run `ha daemon restart`."
      }, { repo }).catch(() => undefined);
    }
  });
  input.runtime.installWriteGuard?.(witness.assertCurrent);
  return witness;
}

export function runWhenBuildCurrent(
  witness: DaemonBuildIdentityWitness,
  action: () => void
): boolean {
  try {
    witness.assertCurrent();
  } catch {
    return false;
  }
  action();
  return true;
}
