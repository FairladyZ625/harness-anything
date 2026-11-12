import { randomUUID } from "node:crypto";
import { BroadcastChannel, setEnvironmentData, threadId } from "node:worker_threads";
import type { TestContext } from "node:test";
import { installAdapter, probeKey } from "./preload.mjs";

export type Entry = { event: string; order: number; [key: string]: any };

export function cutProbe(t: TestContext, schedule: string, fault?: "before-pinned" | "after-pinned") {
  const shared = new SharedArrayBuffer(12),
    cells = new Int32Array(shared);
  const config = {
    shared,
    channel: `backup-cut-${randomUUID()}`,
    taskId: "task_cut000000000000000000000001",
    holdArchive: schedule.startsWith("after-pinned"),
    fault,
  };
  const entries: Entry[] = [];
  const pending = new Set<() => void>();
  const accept = (entry: Entry) => {
    entries.push(entry);
    process.stdout.write(`[backup-cut] ${JSON.stringify({ schedule, ...entry })}\n`);
    for (const check of [...pending]) check();
  };
  const record = (event: string, detail: Record<string, unknown> = {}) =>
    accept({ event, ...detail, producerThreadId: threadId, order: Atomics.add(cells, 1, 1) });
  const wait = (event: string, matches: (entry: Entry) => boolean = () => true): Promise<Entry> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(check);
        reject(new Error(`missing discrete event: ${event}`));
      }, 30_000);
      const check = () => {
        const entry = entries.find((entry) => entry.event === event && matches(entry));
        if (!entry) return;
        clearTimeout(timer);
        pending.delete(check);
        resolve(entry);
      };
      pending.add(check);
      check();
    });
  const channel = new BroadcastChannel(config.channel);
  channel.onmessage = ({ data }) => accept(data);
  setEnvironmentData(probeKey, config);
  const restore = installAdapter(config);
  const release = (index = 0) => {
    record(index === 0 ? "release-requested" : "archive-release-requested");
    Atomics.store(cells, index, 1);
    Atomics.notify(cells, index);
  };
  // Release both worker barriers before fixture teardown, including on assertion failure.
  t.after(() => {
    release();
    release(2);
    setEnvironmentData(probeKey, undefined);
    restore();
    channel.close();
  });
  record("environment", {
    node: process.version,
    platform: process.platform,
    concurrency: process.env.HARNESS_TEST_CONCURRENCY ?? "runner-argv",
    actor: process.env.HARNESS_ACTOR,
  });
  return { config, cells, entries, record, wait, release };
}
