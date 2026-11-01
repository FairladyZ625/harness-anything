import type { Context } from "@deepseek-ai/cordis";
import path from "node:path";
import {
  BROKER_ROUTE,
  chooseWorkspace,
  createBrokerManager,
  readRegisteredRepos,
  type BrokerSubprocessRuntime,
} from "./broker.ts";

export const name = "harness-anything-dsh-plugin";
export const inject = ["subprocess", "webServer", "workspaceRegistry"];

export interface Config {
  /** Fixed workspace root for profile deployments that have one. */
  readonly cwd?: string;
  /** Override the executable during tests or a managed installation. */
  readonly executable?: string;
}

interface HostContext extends Context {
  readonly subprocess: BrokerSubprocessRuntime;
  readonly webServer: {
    getOrigin(): string;
    register(route: {
      readonly kind: "exact";
      readonly path: string;
      readonly handler: (
        request: import("node:http").IncomingMessage,
        response: import("node:http").ServerResponse,
      ) => void | Promise<void>;
    }): () => void;
  };
  readonly workspaceRegistry: {
    list(): readonly { readonly path: string }[];
  };
  readonly effect: (factory: () => void | (() => void | Promise<void>), label?: string) => unknown;
  readonly logger: {
    info(message: string, ...args: readonly unknown[]): void;
    warn(message: string, ...args: readonly unknown[]): void;
  };
}

function listWorkspaces(ctx: HostContext): readonly string[] {
  try {
    return ctx.workspaceRegistry.list().map((workspace) => workspace.path);
  } catch {
    return [];
  }
}

/** Register the lazy Host broker route; all Harness state remains behind the `ha` CLI. */
export function apply(ctx: HostContext, config: Config = {}): void {
  const executable = config.executable ?? "ha";
  const manager = createBrokerManager(ctx.subprocess, {
    executable,
    resolveWorkspace: async (requested) =>
      config.cwd !== undefined && config.cwd.length > 0
        ? config.cwd
        : chooseWorkspace({
            requested,
            workspaces: listWorkspaces(ctx),
            repos: await readRegisteredRepos(ctx.subprocess, executable, process.cwd()),
            separator: path.sep,
            fallback: process.cwd(),
          }),
    getParentOrigin: () =>
      ctx.get("profileContext")?.name === "desktop" ? "dsh-app://app" : ctx.webServer.getOrigin(),
  });
  const unregister = ctx.webServer.register({ kind: "exact", path: BROKER_ROUTE, handler: manager.handle });
  ctx.effect(
    () => async () => {
      unregister();
      await manager.dispose();
    },
    "harness-anything: broker lifecycle",
  );
  ctx.logger.info("harness-anything: broker route registered at %s", BROKER_ROUTE);
}

export { BROKER_ROUTE, createBrokerManager } from "./broker.ts";
export type {
  BrokerFailure,
  BrokerManager,
  BrokerManagerOptions,
  BrokerResponse,
  BrokerSubprocessHandle,
  BrokerSubprocessRuntime,
  BrokerSuccess,
} from "./broker.ts";
