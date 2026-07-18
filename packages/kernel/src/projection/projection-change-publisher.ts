import type { ProjectionChangeEvent } from "./projection-change-event.ts";

export interface ProjectionChangePublisher {
  readonly publish: (event: ProjectionChangeEvent) => void;
  readonly subscribe: (listener: (event: ProjectionChangeEvent) => void) => () => void;
}

export function createProjectionChangePublisher(): ProjectionChangePublisher {
  const listeners = new Set<(event: ProjectionChangeEvent) => void>();
  return {
    publish: (event) => {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // One connection cannot disrupt publication or other subscribers.
        }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
