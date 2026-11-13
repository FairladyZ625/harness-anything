import { daemonRuntimePolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import { statSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { resolveHarnessLayout } from "@harness-anything/kernel/internal/layout/index.ts";
import { runtimeErrorCode, runtimeErrorMessage } from "./runtime-spawn-errors.ts";
import { watchLinuxWorkspace } from "./runtime-workspace-watch-linux.ts";

export type WorkspaceMonitorObservation =
  | { readonly kind: "workspace_activity"; readonly occurredAt: string }
  | { readonly kind: "workspace_removed" }
  | { readonly kind: "workspace_observation_failed"; readonly code: string | null; readonly message: string };

/** Only coalesced workspace observations cross from the watcher to the repository writer. */
export function observeRuntimeWorkspace(
  rootDir: string,
  cwd: string,
  append: (record: WorkspaceMonitorObservation) => void,
  noteActivity: (occurredAt: number) => void = () => undefined,
): { close: () => void } {
  const relativeRoot = path.relative(cwd, resolveHarnessLayout(rootDir).localRoot),
    ignoredRoot = (
      relativeRoot === "" || relativeRoot === "." ? path.join("runtime", "dispatches") : relativeRoot
    ).replaceAll(path.sep, "/");
  let watcher: Pick<FSWatcher, "close" | "unref" | "on"> | ReturnType<typeof watchLinuxWorkspace> | null = null,
    timer: NodeJS.Timeout | null = null,
    pendingRename = false,
    pendingActivity: number | null = null,
    lastEmittedAt = -Infinity,
    closed = false;
  const removed = (): boolean => !statSync(cwd, { throwIfNoEntry: false });
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    watcher?.close();
    watcher = null;
  };
  const fail = (error: unknown): void => {
    if (closed) return;
    const code = runtimeErrorCode(error);
    if ((code === "ENOENT" || code === "EPERM") && removed()) {
      close();
      append({ kind: "workspace_removed" });
      return;
    }
    close();
    append({ kind: "workspace_observation_failed", code, message: runtimeErrorMessage(error) });
  };
  const flush = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    const renamed = pendingRename,
      changed = pendingActivity;
    pendingRename = false;
    pendingActivity = null;
    const rootRemoved = renamed && removed();
    if (rootRemoved) {
      close();
      append({ kind: "workspace_removed" });
    } else if (changed !== null) {
      lastEmittedAt = Date.now();
      append({ kind: "workspace_activity", occurredAt: new Date(changed).toISOString() });
    }
  };
  const onChange = (eventType: string, filename: string | Buffer | null): void => {
    if (closed) return;
    const normalized = (typeof filename === "string" ? filename : String(filename ?? "")).replaceAll(path.sep, "/");
    if (normalized === ignoredRoot || (ignoredRoot !== "" && normalized.startsWith(`${ignoredRoot}/`))) return;
    pendingRename ||= eventType === "rename";
    if (normalized) {
      pendingActivity = Date.now();
      noteActivity(pendingActivity);
    }
    const remaining = lastEmittedAt + daemonRuntimePolicy.defaultValue.runtime.workspaceActivityIntervalMs - Date.now();
    if (remaining <= 0) flush();
    else if (!timer) {
      timer = setTimeout(flush, remaining);
      timer.unref();
    }
  };
  if (removed()) {
    append({ kind: "workspace_removed" });
    return { close };
  }
  try {
    watcher =
      process.platform === "linux" ? watchLinuxWorkspace(cwd, onChange) : watch(cwd, { recursive: true }, onChange);
    watcher.on("error", fail);
    watcher.unref?.();
  } catch (error) {
    const code = runtimeErrorCode(error);
    if ((code === "ENOENT" || code === "EPERM") && removed()) {
      close();
      append({ kind: "workspace_removed" });
      return { close };
    }
    throw error;
  }
  return {
    close: () => {
      if (!closed && (pendingRename || pendingActivity !== null)) flush();
      close();
    },
  };
}
