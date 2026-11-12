import { mkdir, open, readdir, rm, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";

// Local write sinks for the external probe. They live in the daemon package because that package
// already owns the daemon's local log files; the CLI probe is a reader/producer, not a writer, so
// the thin-CLI write boundary stays intact.
export function probeTimelineStem(daemonId: string): string {
  return `daemon-${safeProbeRuntimeId(daemonId)}-probe-`;
}

export function probeTimelinePath(dir: string, daemonId: string, day: string): string {
  return path.join(dir, `${probeTimelineStem(daemonId)}${day}.jsonl`);
}

export function probeDayStamp(at: Date): string {
  return at.toISOString().slice(0, 10).replaceAll("-", "");
}

export interface ProbeLogSinkOptions {
  readonly dir: string;
  readonly daemonId: string;
  readonly keptDays: number;
  readonly now?: () => Date;
  readonly onFailure?: (error: unknown) => void;
}

export interface ProbeLogSink {
  readonly appendLine: (line: string) => Promise<void>;
  readonly close: () => Promise<void>;
}

export function createProbeLogSink(options: ProbeLogSinkOptions): ProbeLogSink {
  const now = options.now ?? (() => new Date());
  let chain: Promise<void> = Promise.resolve(),
    settled = false,
    handle: FileHandle | null = null,
    openDay = "";

  const appendLine = (line: string): Promise<void> => {
    if (settled) return Promise.resolve();
    // A transient mkdir/open/write failure must not poison the queue: the next append retries on a
    // fresh chain position instead of inheriting a permanently rejected promise.
    chain = chain.then(
      () => writeLine(line),
      () => writeLine(line),
    );
    return chain;
  };

  async function writeLine(line: string): Promise<void> {
    const day = probeDayStamp(now());
    try {
      if (handle === null || day !== openDay) {
        await closeHandle();
        await /* @gate-identity non-state/environment-io.9be0f8fbd8c5f109 */ mkdir(options.dir, { recursive: true });
        openDay = day;
        handle = await /* @gate-identity non-state/environment-io.f2d57822d6b3d560 */ open(
          probeTimelinePath(options.dir, options.daemonId, day),
          "a",
        );
        await pruneOldDays(options.dir, options.daemonId, options.keptDays);
      }
      await handle.write(line);
    } catch (error) {
      const failure = error;
      await closeHandle();
      (options.onFailure ?? defaultProbeLogFailureReporter)(failure);
      throw failure;
    }
  }

  async function closeHandle(): Promise<void> {
    if (handle === null) return;
    const closing = handle;
    handle = null;
    openDay = "";
    await closing.close().catch(() => undefined);
  }

  return {
    appendLine,
    close: async () => {
      settled = true;
      await chain.catch(() => undefined);
      await closeHandle();
    },
  };
}

/** Create a capture directory before a tool that writes into it runs. */
export async function ensureProbeDirectory(dir: string): Promise<void> {
  await /* @gate-identity non-state/environment-io.690433e47117a394 */ mkdir(dir, { recursive: true });
}

/** Write one capture artifact and return its path; the caller records that path in the timeline. */
export async function writeProbeFile(dir: string, name: string, body: string): Promise<string> {
  await ensureProbeDirectory(dir);
  const file = path.join(dir, name);
  await /* @gate-identity non-state/environment-io.b71e5d2d09de6e06 */ writeFile(file, body, "utf8");
  return file;
}

async function pruneOldDays(dir: string, daemonId: string, keptDays: number): Promise<void> {
  const pattern = new RegExp(`^${escapeRegExp(probeTimelineStem(daemonId))}(\\d{8})\\.jsonl$`, "u");
  const names = await readdir(dir).catch(() => null);
  if (names === null) return;
  const days = names
      .flatMap((name) => pattern.exec(name)?.[1] ?? [])
      .filter((day, index, all) => all.indexOf(day) === index)
      .sort(),
    keep = days.slice(-keptDays);
  for (const name of names) {
    const day = pattern.exec(name)?.[1];
    if (day !== undefined && !keep.includes(day))
      await /* @gate-identity non-state/environment-io.3ed3a8e5f168e3da */ rm(path.join(dir, name), { force: true });
  }
}

function safeProbeRuntimeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/gu, "-");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function defaultProbeLogFailureReporter(error: unknown): void {
  process.stderr.write(
    `harness daemon probe: probe log write failure: ${error instanceof Error ? error.message : String(error)}\n`,
  );
}
