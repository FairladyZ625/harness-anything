import { createInterface } from "node:readline";
import { makeTaskHolderService, taskHolderActor } from "../../src/index.ts";

const [rootDir, personId] = process.argv.slice(2);
if (!rootDir || !personId) throw new Error("task-holder claim worker requires rootDir and personId");

const service = makeTaskHolderService({
  rootInput: rootDir,
  now: () => new Date("2026-07-10T00:00:00.000Z")
});
const principal = taskHolderActor({ personId }, null);
const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });

process.stdout.write(`${JSON.stringify({ ready: true })}\n`);

for await (const line of lines) {
  const input = JSON.parse(line) as { readonly taskId: string };
  try {
    await service.claim({ taskId: input.taskId, principal, ttlMs: 60_000 });
    process.stdout.write(`${JSON.stringify({ taskId: input.taskId, ok: true })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      taskId: input.taskId,
      ok: false,
      code: error instanceof Error && "code" in error ? error.code : "unknown"
    })}\n`);
  }
}
