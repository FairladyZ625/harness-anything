// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { stopDaemon, withTempRootAsync, runRawJson, defaultDaemonUserRoot } from "../../cli/test/helpers/daemon-cli.ts";
import { createLocalGuiServiceBridge } from "../src/main/local-composition-root.ts";
import { createLocalGuiProjectionNotifications } from "../src/main/projection-notifications.ts";
import { applyProjectionChange, type RendererProjectionChange } from "../src/renderer/projection-notifications.ts";

test("real daemon write refreshes an active GUI query without polling", async () => {
  await withTempRootAsync(async (rootDir) => {
    const userRoot = defaultDaemonUserRoot(rootDir);
    const restoreEnv = replaceEnv({
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_USER_ROOT: userRoot,
      HARNESS_DAEMON_IDLE_MS: "5000"
    });
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "fixture", HARNESS_DAEMON_USER_ROOT: userRoot });
    const bridge = createLocalGuiServiceBridge(rootDir);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } });
    const queryKey = ["harness", "tasks", "list", "canonical"] as const;
    const observer = new QueryObserver(queryClient, {
      queryKey,
      queryFn: async () => bridge.invoke("getTasks", { repoId: "canonical" }) as Promise<TaskListResult>
    });
    const unsubscribeObserver = observer.subscribe(() => undefined);
    const notifications = createLocalGuiProjectionNotifications(rootDir);
    try {
      await observer.refetch();
      assert.deepEqual(taskIds(observer.getCurrentResult().data), []);
      const watched = await notifications.source.watch("canonical", (notification) => {
        if (notification.type === "change") applyProjectionChange(queryClient, notification as RendererProjectionChange);
      });
      assert.deepEqual(watched, { mode: "push" });

      const created = runRawJson(rootDir, ["new-task", "--title", "Push Refreshed Task"], {
        HARNESS_DAEMON_MODE: "local",
        HARNESS_DAEMON_USER_ROOT: userRoot,
        HARNESS_DAEMON_IDLE_MS: "5000"
      });
      const createdId = receiptTaskId(created);
      await waitFor(() => taskIds(observer.getCurrentResult().data).includes(createdId));
      assert.equal(taskIds(observer.getCurrentResult().data).includes(createdId), true);
    } finally {
      unsubscribeObserver();
      await notifications.dispose();
      queryClient.clear();
      await stopDaemon(rootDir, userRoot);
      restoreEnv();
    }
  });
});

interface TaskListResult {
  readonly ok?: boolean;
  readonly tasks?: ReadonlyArray<{ readonly taskId?: string }>;
}

function taskIds(result: TaskListResult | undefined): ReadonlyArray<string> {
  return result?.tasks?.flatMap((task) => typeof task.taskId === "string" ? [task.taskId] : []) ?? [];
}

function receiptTaskId(receipt: Record<string, unknown>): string {
  const details = receipt.details as Record<string, unknown> | undefined;
  const data = details?.data as Record<string, unknown> | undefined;
  if (typeof data?.taskId !== "string") throw new Error(`write receipt lacked taskId: ${JSON.stringify(receipt)}`);
  return data.taskId;
}

function replaceEnv(values: Readonly<Record<string, string>>): () => void {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("GUI query did not refresh from projection notification");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
