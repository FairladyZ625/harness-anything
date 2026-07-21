import type { DaemonServeHooks } from "@harness-anything/daemon";
import type { ParsedDaemonLaunchArgv } from "../../daemon/daemon-launch-spec.ts";
import type { DaemonControlLifecycle, DaemonControlRequest } from "./control.ts";
import type { DaemonSnapshotInstallInput, InstalledDaemonSnapshot } from "./snapshot.ts";

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
  readonly installDaemonSnapshot?: (input: DaemonSnapshotInstallInput) => InstalledDaemonSnapshot;
  readonly daemonSourceEntrypoint?: () => string;
}

export type { DaemonServeHooks } from "@harness-anything/daemon";
