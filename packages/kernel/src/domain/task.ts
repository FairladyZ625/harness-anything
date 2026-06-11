import type { LifecycleBinding } from "./lifecycle-binding.js";

export type TaskId = string;
export type EngineId = string;
export type ExternalRef = string;
export type IsoTimestamp = string;
export type Sha256Fingerprint = `sha256:${string}`;

export interface TaskIdentity {
  readonly id: TaskId;
  readonly title: string;
}

export interface Task {
  readonly id: TaskId;
  readonly title: string;
  readonly lifecycle: LifecycleBinding;
}

export function createTaskIdentity(id: TaskId, title: string): TaskIdentity {
  return { id, title };
}
