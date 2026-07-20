import type { AuthorityRepoLifecycleController } from "@harness-anything/daemon";
import type { ParsedDaemonLaunchArgv } from "../../daemon/daemon-launch-spec.ts";
import type { DaemonControlLifecycle, DaemonControlRequest } from "./control.ts";

export interface DaemonCommandInput {
  readonly rootDir: string;
  readonly layoutOverrides?: { readonly authoredRoot?: string };
  readonly launchOptions?: ParsedDaemonLaunchArgv;
  readonly rawArgs?: ReadonlyArray<string>;
  readonly json: boolean;
  readonly args: ReadonlyArray<string>;
  readonly runServe: (
    rootDir: string,
    layoutOverrides: { readonly authoredRoot?: string } | undefined,
    args: ReadonlyArray<string>,
    hooks?: DaemonServeHooks,
    launchOptions?: ParsedDaemonLaunchArgv
  ) => Promise<void>;
  readonly requestDaemonControl?: (request: DaemonControlRequest) => Promise<Record<string, unknown>>;
  readonly daemonControlLifecycle?: DaemonControlLifecycle;
}

export interface DaemonServeHooks {
  readonly onStarted?: (status: Record<string, unknown>) => void;
  /** Production/test composition point; absent until S supplies all authority inputs. */
  readonly authorityLifecycle?: AuthorityRepoLifecycleController;
}
