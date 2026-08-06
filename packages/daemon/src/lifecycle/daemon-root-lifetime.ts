import { statSync, watch, type FSWatcher } from "node:fs";

export const daemonRootLifetimePollMs = 250;
export const daemonAutostartRootLifetimeEnvironmentVariable = "HARNESS_DAEMON_AUTOSTART_ROOT_IDENTITY";

export type DaemonRootAwareStopTrigger =
  | { readonly reason: "root-unavailable" }
  | { readonly reason: "signal"; readonly signal: "SIGINT" | "SIGTERM" }
  | { readonly reason: "control"; readonly kind: "restart" | "refresh" | "upgrade" }
  | { readonly reason: "idle-timeout" };

export interface DaemonRootLifetimeMonitor {
  readonly rootLost: Promise<{ readonly reason: "root-unavailable" }>;
  readonly rootAvailable: () => boolean;
  readonly stop: () => void;
}

export interface DaemonRootLifetimeGuard {
  readonly assertAvailable: () => void;
  readonly waitForStop: (
    signal: Promise<Extract<DaemonRootAwareStopTrigger, { readonly reason: "signal" }>>,
    request: Promise<Exclude<DaemonRootAwareStopTrigger, { readonly reason: "signal" | "root-unavailable" }>>
  ) => Promise<DaemonRootAwareStopTrigger>;
  readonly terminalReason: (trigger: DaemonRootAwareStopTrigger) => string;
  readonly stop: () => void;
}

export function daemonAutostartRootLifetimeEnabled(env: NodeJS.ProcessEnv): boolean {
  return daemonAutostartRootIdentity(env) !== undefined;
}

export function daemonAutostartRootIdentity(env: NodeJS.ProcessEnv): string | undefined {
  const value = env[daemonAutostartRootLifetimeEnvironmentVariable]?.trim();
  return value ? value : undefined;
}

export function daemonRootIdentity(rootDir: string): string | undefined {
  try {
    const stat = statSync(rootDir, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
  } catch {
    return undefined;
  }
}

export function monitorDaemonRootLifetime(
  rootDir: string,
  expectedIdentity = daemonRootIdentity(rootDir) ?? "missing"
): DaemonRootLifetimeMonitor {
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let lost = false;
  let resolveRootLost: ((trigger: { readonly reason: "root-unavailable" }) => void) | undefined;
  const rootLost = new Promise<{ readonly reason: "root-unavailable" }>((resolve) => {
    resolveRootLost = resolve;
  });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    watcher?.close();
    watcher = undefined;
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const inspect = () => {
    if (stopped || daemonRootIdentity(rootDir) === expectedIdentity) return;
    lost = true;
    stop();
    resolveRootLost?.({ reason: "root-unavailable" });
  };

  inspect();
  if (!stopped) {
    try {
      watcher = watch(rootDir, { persistent: false }, inspect);
      watcher.on("error", () => {
        watcher?.close();
        watcher = undefined;
      });
    } catch {
      // The interval is the cross-platform fallback for unavailable watchers.
    }
    timer = setInterval(inspect, daemonRootLifetimePollMs);
    timer.unref();
  }
  return {
    rootLost,
    rootAvailable: () => {
      inspect();
      return !lost;
    },
    stop
  };
}

export function daemonRootLifetimeGuard(
  rootDir: string,
  expectedIdentity: string | undefined
): DaemonRootLifetimeGuard {
  const monitor = expectedIdentity === undefined
    ? undefined
    : monitorDaemonRootLifetime(rootDir, expectedIdentity);
  const rootLost = monitor?.rootLost ?? new Promise<never>(() => {});
  return {
    assertAvailable: () => {
      if (monitor?.rootAvailable() === false) {
        throw new Error(`DAEMON_AUTOSTART_ROOT_UNAVAILABLE:${rootDir}`);
      }
    },
    waitForStop: (signal, request) => Promise.race([signal, request, rootLost]),
    terminalReason: (trigger) => trigger.reason === "root-unavailable"
      ? "root-unavailable"
      : trigger.reason === "signal"
        ? `signal:${trigger.signal}`
        : trigger.reason === "control"
          ? `control:${trigger.kind}`
          : "idle-timeout",
    stop: () => monitor?.stop()
  };
}
