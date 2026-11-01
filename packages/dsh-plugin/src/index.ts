import type { Context } from "@deepseek-ai/cordis";
import { BROKER_ROUTE, createBrokerManager, type BrokerSubprocessRuntime } from "./broker.ts";

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

function currentWorkspace(ctx: HostContext, config: Config): string {
  if (config.cwd !== undefined && config.cwd.length > 0) return config.cwd;
  try {
    return ctx.workspaceRegistry.list()[0]?.path ?? process.cwd();
  } catch {
    return process.cwd();
  }
}

/** Register the lazy Host broker route; all Harness state remains behind the `ha` CLI. */
export function apply(ctx: HostContext, config: Config = {}): void {
  const manager = createBrokerManager(ctx.subprocess, {
    executable: config.executable,
    getWorkspace: () => currentWorkspace(ctx, config),
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
