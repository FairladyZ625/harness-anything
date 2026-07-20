import type { Disposable, ProjectionChangeNotification, Subscription } from "@harness-anything/api-contracts";
import { JsonLineSocketTransport, PersistentDaemonClient } from "@harness-anything/daemon-client";
import type {
  HarnessProjectionNotificationSource
} from "./ipc-handlers.ts";
import type { RendererProjectionNotification } from "../preload/allowlist.ts";
import { resolveGuiDaemonNotificationTarget } from "./local-composition-root.ts";

const daemonConnectionTimeoutMs = 6_000;
const projectionSubscriptionTimeoutMs = 1_000;

export interface LocalGuiProjectionNotifications {
  readonly source: HarnessProjectionNotificationSource;
  readonly dispose: () => Promise<void>;
}

export function createLocalGuiProjectionNotifications(rootDir: string): LocalGuiProjectionNotifications {
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
    const target = await resolveGuiDaemonNotificationTarget(rootDir);
    client = new PersistentDaemonClient({
      endpoint: target.socketPath,
      transport: new JsonLineSocketTransport(),
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
