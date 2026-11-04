// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { chainRepoCellWrite } from "../src/repo-cell.ts";

test("a second write starts only after the first queued write settles", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    order: string[] = [];
  let tail: Promise<void> = Promise.resolve();
  const first = chainRepoCellWrite(tail, async () => {
    order.push("first-start");
    await gate;
    order.push("first-end");
  });
  tail = first.then(
    () => undefined,
    () => undefined,
  );
  const second = chainRepoCellWrite(tail, () => {
    order.push("second-start");
  });
  for (let turn = 0; turn < 10 && order.length === 0; turn += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first-start"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
});
