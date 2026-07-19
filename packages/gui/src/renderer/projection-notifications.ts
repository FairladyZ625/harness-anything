import type { Query, QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { setProjectionPushActive } from "./query-client.ts";

export interface RendererProjectionChange {
  readonly type: "change";
  readonly repoId: string;
  readonly event: {
    readonly schema: "projection-change/v1";
    readonly sourceHash: string;
    readonly entities: ReadonlyArray<{ readonly kind: string; readonly id: string }>;
  };
}

export interface RendererProjectionState {
  readonly type: "state";
  readonly mode: "push" | "polling";
  readonly diagnostic?: string;
}

export type RendererProjectionNotification = RendererProjectionChange | RendererProjectionState;

export function useProjectionNotifications(repoId: string | null): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!repoId) return;
    const bridge = window.harness;
    if (!bridge?.watchProjectionChanges || !bridge.onProjectionChanged) {
      enablePolling(queryClient, "Projection notification bridge is unavailable.");
      return;
    }
    let current = true;
    const stop = bridge.onProjectionChanged((notification) => {
      if (!current) return;
      if (notification.type === "state") {
        setProjectionMode(queryClient, notification.mode, notification.diagnostic);
        return;
      }
      if (notification.repoId === repoId) applyProjectionChange(queryClient, notification);
    });
    void bridge.watchProjectionChanges(repoId).then((result) => {
      if (current) setProjectionMode(queryClient, result.mode, result.diagnostic);
    }).catch((error: unknown) => {
      if (current) enablePolling(queryClient, `Projection subscription failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return () => {
      current = false;
      stop();
    };
  }, [queryClient, repoId]);
}

export function applyProjectionChange(queryClient: QueryClient, notification: RendererProjectionChange): void {
  const entities = notification.event.entities;
  const predicate = entities.length === 0
    ? (query: Query) => isRepoQuery(query, notification.repoId)
    : (query: Query) => entities.some((entity) => entityInvalidatesQuery(entity, query, notification.repoId));
  void queryClient.invalidateQueries({ predicate });
}

function setProjectionMode(queryClient: QueryClient, mode: "push" | "polling", diagnostic?: string): void {
  setProjectionPushActive(mode === "push");
  if (diagnostic) console.warn(`[renderer-projection-notifications] ${diagnostic}`);
  void queryClient.invalidateQueries({ queryKey: ["harness"] });
}

function enablePolling(queryClient: QueryClient, diagnostic: string): void {
  setProjectionMode(queryClient, "polling", diagnostic);
}

function entityInvalidatesQuery(
  entity: { readonly kind: string; readonly id: string },
  query: Query,
  repoId: string
): boolean {
  if (!isRepoQuery(query, repoId)) return false;
  const key = query.queryKey;
  const surface = key[1];
  if (entity.kind === "task") {
    return surface === "tasks" && (key[2] === "list" || key.includes(entity.id))
      || surface === "triadic"
      || surface === "executions"
      || surface === "execution-evidence";
  }
  if (entity.kind === "decision" || entity.kind === "fact" || entity.kind === "relation") return surface === "triadic";
  if (entity.kind === "execution" || entity.kind === "evidence") {
    return surface === "executions" || surface === "execution-evidence";
  }
  return true;
}

function isRepoQuery(query: Query, repoId: string): boolean {
  const key = query.queryKey;
  if (key[0] !== "harness") return false;
  return key.includes(repoId) || key.includes("default");
}
