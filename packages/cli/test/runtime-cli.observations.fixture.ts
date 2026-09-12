import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { makeTaskEventReader } from "../../kernel/src/index.ts";
import { run } from "./runtime-cli.commands.fixture.ts";

export async function runtimeInvariantEvidence(
  root: string,
  artifactRoot: string,
  spawned: Record<string, unknown>,
  settled: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const dispatchId = String(spawned.dispatchId),
    runtimeSessionId = String(spawned.runtimeSessionId),
    archivePath = path.join(artifactRoot, "dispatches", `${dispatchId}.json`),
    reportPath = path.join(artifactRoot, "reports", `${dispatchId}.md`),
    archive = JSON.parse(await readPublishedDispatch(archivePath)) as Record<string, unknown>,
    events = makeTaskEventReader({ repoId: "runtime-cli", rootDir: root })
      .read()
      .events.filter(
        (event) => "runtimeSessionId" in event.payload && event.payload.runtimeSessionId === runtimeSessionId,
      ),
    observed = events.filter((event) => event.type === "runtime_session_outcome_observed");
  await eventuallyFile(reportPath);
  return {
    outcome: settled.outcome,
    exitCode: ((settled.session as Record<string, unknown>).activity as Record<string, unknown>).exitCode,
    archiveExists: existsSync(archivePath),
    archiveOutcome: archive.outcome,
    archiveExitCode: archive.exitCode,
    reportExists: existsSync(reportPath),
    exitedEvents: events.filter((event) => event.type === "runtime_session_exited").length,
    observedEvents: observed.length,
    observedOutcome: observed[0]?.type === "runtime_session_outcome_observed" ? observed[0].payload.outcome : null,
    observedExitCode: observed[0]?.type === "runtime_session_outcome_observed" ? observed[0].payload.exitCode : null,
  };
}
export function readDispatchRecords(root: string, dispatchId: string): Record<string, unknown>[] {
  return readFileSync(path.join(root, ".harness", "runtime", "dispatches", `${dispatchId}.jsonl`), "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
export async function eventuallyNotification(
  root: string,
  dispatchId: string,
): Promise<{ readonly started: Record<string, unknown> | undefined; readonly finished: Record<string, unknown> }> {
  let records: Record<string, unknown>[] = [];
  for (let attempt = 0; attempt < 500; attempt += 1) {
    records = readDispatchRecords(root, dispatchId).filter((record) => record.kind === "exit_notification");
    const finished = records.find((record) => record.phase === "finished");
    if (finished) return { started: records.find((record) => record.phase === "started"), finished };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`notification did not settle: ${JSON.stringify(records)}`);
}
export async function readPublishedDispatch(target: string): Promise<string> {
  await eventuallyFile(target);
  return readFileSync(target, "utf8");
}
export async function eventuallyFile(target: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(target)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`file did not appear: ${target}`);
}
export async function eventually<T>(read: () => T): Promise<T> {
  let last: T | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    last = read();
    const rows = (last as Record<string, unknown>).dispatches;
    if (Array.isArray(rows) && rows.some((row) => (row as Record<string, unknown>).status === "cancelled")) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`dispatch did not settle: ${JSON.stringify(last)}`);
}
export async function eventuallyRuntimeStatus(
  root: string,
  env: NodeJS.ProcessEnv,
  runtimeSessionId: string,
  liveness: string,
): Promise<{ readonly session: Record<string, unknown> & { readonly activity: Record<string, unknown> } }> {
  let last: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 500; attempt += 1) {
    last = run(root, env, ["runtime", "status", runtimeSessionId]);
    const session = last.session as Record<string, unknown> & { readonly activity: Record<string, unknown> };
    if (session.liveness === liveness) return { session };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`runtime status did not reach ${liveness}: ${JSON.stringify(last)}`);
}
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
export async function eventuallyRuntimeReaderReuse(
  userRoot: string,
  daemonId: string,
): Promise<{ readonly conn: string; readonly helloCount: number; readonly statusReads: number }> {
  let observed: Record<string, string[]> = {};
  for (let attempt = 0; attempt < 100; attempt += 1) {
    observed = {};
    const logRoot = path.join(userRoot, "logs"),
      names = existsSync(logRoot)
        ? readdirSync(logRoot).filter((name) => name.startsWith(`daemon-${daemonId}-conn-`) && name.endsWith(".jsonl"))
        : [];
    for (const name of names)
      for (const line of readFileSync(path.join(logRoot, name), "utf8").trim().split("\n").filter(Boolean)) {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record.event !== "request" || typeof record.conn !== "string" || typeof record.method !== "string")
          continue;
        const key = `${String(record.pid)}:${record.conn}`;
        (observed[key] ??= []).push(record.method);
      }
    const reused = Object.entries(observed).find(
      ([, methods]) =>
        methods.filter((method) => method === "repo.agentRuntime.sessions.read").length >= 2 &&
        methods.filter((method) => method === "protocol.hello").length === 1,
    );
    if (reused)
      return {
        conn: reused[0],
        helloCount: 1,
        statusReads: reused[1].filter((method) => method === "repo.agentRuntime.sessions.read").length,
      };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`runtime status wait did not reuse one daemon connection: ${JSON.stringify(observed)}`);
}
export function assertTaskMissionPrompt(
  prompt: string,
  expected: {
    readonly repoId: string;
    readonly taskId: string;
    readonly canonicalRoot: string;
    readonly workerRoot: string;
    readonly taskPackageRoot: string;
    readonly daemonUserRoot: string;
    readonly daemonId: string;
    readonly runtimeSessionId: string;
    readonly mission: string;
  },
): void {
  assert.ok(
    prompt.includes(
      `# Dispatch Preconditions\nRepository id: ${expected.repoId}\nRepository registration: enabled\nCanonical repository root: ${expected.canonicalRoot}\nWorker repository root: ${expected.workerRoot}\nCanonical Task ID: ${expected.taskId}\nTask package root: ${expected.taskPackageRoot}\nDaemon user root: ${expected.daemonUserRoot}\nDaemon id: ${expected.daemonId}\nDaemon endpoint: `,
    ),
    prompt,
  );
  assert.ok(prompt.includes(`\nRuntime actor: agent:runtime-session:${expected.runtimeSessionId}\n`), prompt);
  assert.ok(prompt.endsWith(`# Assigned Mission\n${expected.mission}`), prompt);
}
