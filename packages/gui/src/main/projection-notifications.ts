import type { Disposable, ProjectionChangeNotification, Subscription } from "@harness-anything/api-contracts";
import { JsonLineSocketTransport, PersistentDaemonClient, type PersistentTransport } from "@harness-anything/daemon-client";
import { SshStdioTransport } from "../../../daemon-client/src/ssh-stdio-transport.ts";
import type { DaemonTransport } from "../daemon/remote-tunnel.ts";
import type {
  HarnessProjectionNotificationSource
} from "./ipc-handlers.ts";
import type { RendererProjectionNotification } from "../preload/allowlist.ts";
import {
  resolveGuiDaemonTransport,
  resolveGuiDaemonNotificationTarget,
  type HarnessLayoutOverrides
} from "./local-composition-root.ts";

const daemonConnectionTimeoutMs = 6_000;
const projectionSubscriptionTimeoutMs = 1_000;

export interface LocalGuiProjectionNotifications {
  readonly source: HarnessProjectionNotificationSource;
  readonly dispose: () => Promise<void>;
}

export function createLocalGuiProjectionNotifications(
  rootDir: string,
  layoutOverrides?: HarnessLayoutOverrides
): LocalGuiProjectionNotifications {
  return createProjectionNotifications(rootDir, layoutOverrides, true);
}

export function createGuiProjectionNotifications(
  rootDir: string,
  layoutOverrides?: HarnessLayoutOverrides,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly createSshTransport?: (transport: Extract<DaemonTransport, { readonly kind: "ssh-stdio" }>) => PersistentTransport;
  } = {}
): LocalGuiProjectionNotifications {
  return createProjectionNotifications(rootDir, layoutOverrides, false, options);
}

function createProjectionNotifications(
  rootDir: string,
  layoutOverrides: HarnessLayoutOverrides | undefined,
  forceLocal: boolean,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly createSshTransport?: (transport: Extract<DaemonTransport, { readonly kind: "ssh-stdio" }>) => PersistentTransport;
  } = {}
): LocalGuiProjectionNotifications {
  let client: PersistentDaemonClient | undefined;
  let clientEvents: Disposable | undefined;
  let clientState: Disposable | undefined;
  let subscription: Subscription | undefined;
  let watchedRepoId: string | undefined;
  let sink: ((notification: RendererProjectionNotification) => void) | undefined;

  const source: HarnessProjectionNotificationSource = {
    watch: async (repoId, nextSink) => {
      sink = nextSink;
      if (subscription && watchedRepoId === repoId) return { mode: "push" };
      await subscription?.dispose();
      subscription = undefined;
      watchedRepoId = repoId;
      try {
        const activeClient = await ensureClient();
        const hello = await activeClient.connect(AbortSignal.timeout(daemonConnectionTimeoutMs));
        if (!hello.repos.some((repo) => repo.repoId === repoId)) {
          throw new Error(`repo_not_advertised: daemon hello did not advertise ${repoId}`);
        }
        subscription = await activeClient.subscribe(repoId);
        return { mode: "push" };
      } catch (error) {
        const diagnostic = `Projection notifications unavailable for ${repoId}: ${error instanceof Error ? error.message : String(error)}`;
        traceProjectionDiagnostic(diagnostic);
        nextSink({ type: "state", mode: "polling", diagnostic });
        return { mode: "polling", diagnostic };
      }
    }
  };

  return {
    source,
    dispose: async () => {
      sink = undefined;
      clientEvents?.dispose();
      clientState?.dispose();
      await subscription?.dispose();
      await client?.dispose();
    }
  };

  async function ensureClient(): Promise<PersistentDaemonClient> {
    if (client) return client;
    const selected = forceLocal ? undefined : await resolveGuiDaemonTransport(rootDir, layoutOverrides, options.env);
    const target = selected?.kind === "ssh-stdio"
      ? {
          endpoint: `ssh-stdio:${selected.host}`,
          transport: options.createSshTransport?.(selected)
            ?? new SshStdioTransport({ host: selected.host, remoteHaPath: selected.remoteHaPath })
        }
      : await resolveGuiDaemonNotificationTarget(rootDir, layoutOverrides).then((local) => ({
          endpoint: local.socketPath,
          transport: new JsonLineSocketTransport()
        }));
    client = new PersistentDaemonClient({
      endpoint: target.endpoint,
      transport: target.transport,
      helloTimeoutMs: daemonConnectionTimeoutMs,
      requestTimeoutMs: projectionSubscriptionTimeoutMs,
      onDiagnostic: (diagnostic) => {
        const message = `${diagnostic.code}: ${diagnostic.message}`;
        traceProjectionDiagnostic(message);
        sink?.({
          type: "state",
          mode: diagnostic.code === "subscription_failed" ? "polling" : "push",
          diagnostic: message
        });
      }
    });
    clientEvents = client.onEvent(forwardProjectionChange);
    clientState = client.onState((state) => {
      if (state === "stale") sink?.({ type: "state", mode: "polling", diagnostic: "Daemon notification connection became stale." });
      if (state === "live" && subscription) sink?.({ type: "state", mode: "push" });
    });
    return client;
  }

  function forwardProjectionChange(notification: ProjectionChangeNotification): void {
    sink?.({ type: "change", repoId: notification.repoId, event: notification.event });
  }
}

function traceProjectionDiagnostic(message: string): void {
  console.warn(`[gui-projection-notifications] ${message}`);
}
