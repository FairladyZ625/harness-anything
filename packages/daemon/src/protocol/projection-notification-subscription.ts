import { failureReceipt, successReceipt } from "./receipt-envelope.ts";
import type { JsonRpcNotification, JsonValue } from "./json-rpc-types.ts";
import type { DaemonRepoNamespace } from "./json-rpc-server.ts";

export interface ProjectionChangeEvent {
  readonly schema: "projection-change/v1";
  readonly sourceHash: string;
  readonly entities: ReadonlyArray<{ readonly kind: string; readonly id: string }>;
}

export interface ProjectionNotificationOptions {
  readonly notificationSink?: (notification: JsonRpcNotification) => void;
  readonly subscribeProjectionChanges?: (
    repo: DaemonRepoNamespace,
    listener: (event: ProjectionChangeEvent) => void
  ) => () => void;
}

export interface ProjectionNotificationSession {
  readonly subscriptions: Map<string, () => void>;
  readonly close: () => Promise<void>;
}

export function createProjectionNotificationSession(): ProjectionNotificationSession {
  const subscriptions = new Map<string, () => void>();
  return {
    subscriptions,
    close: async () => {
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
    }
  };
}

export function handleProjectionNotificationSubscription(
  method: string,
  repo: DaemonRepoNamespace,
  options: ProjectionNotificationOptions,
  subscriptions: Map<string, () => void>
) {
  const current = subscriptions.get(repo.repoId);
  if (method === "repo.notifications.unsubscribe") {
    current?.();
    subscriptions.delete(repo.repoId);
    return successReceipt(method, `unsubscribed from projection changes for ${repo.repoId}`, {
      subscription: "projection-change/v1"
    });
  }
  if (!options.notificationSink || !options.subscribeProjectionChanges) {
    return failureReceipt(
      method,
      "notifications_unavailable",
      "Projection notification transport is not configured. Run `ha daemon start`, reconnect through a daemon transport, then retry the subscription."
    );
  }
  current?.();
  subscriptions.set(repo.repoId, options.subscribeProjectionChanges(repo, (event) => {
    options.notificationSink?.({
      jsonrpc: "2.0",
      method: "repo.projection.changed",
      params: {
        repo: { repoId: repo.repoId },
        event: event as unknown as JsonValue
      }
    });
  }));
  return successReceipt(method, `subscribed to projection changes for ${repo.repoId}`, {
    subscription: "projection-change/v1"
  });
}
