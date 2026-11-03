// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import reportTestFailures from "./node-test-failure-reporter.mjs";

async function render(events) {
  async function* source() {
    yield* events;
  }
  const chunks = [];
  for await (const chunk of reportTestFailures(source())) chunks.push(chunk);
  return chunks.join("");
}

const failure = (overrides) => ({
  type: "test:fail",
  data: {
    name: "a test",
    file: "packages/daemon/test/example.test.ts",
    details: { error: new AssertionError("expected one", "actual two") },
    ...overrides,
  },
});

class AssertionError extends Error {
  constructor(actual, expected) {
    super(`${actual} == ${expected}`);
    this.name = "AssertionError";
  }
}

test("a failure is rendered with its real assertion stack before the run ends", async () => {
  const output = await render([failure()]);
  assert.match(output, /^\[test-failure\] packages\/daemon\/test\/example\.test\.ts: a test$/mu);
  assert.match(output, /AssertionError: expected one == actual two/u);
  assert.match(output, /node-test-failure-reporter\.test\.mjs/u);
});

test("the ERR_TEST_FAILURE wrapper is unwrapped to the assertion the test threw", async () => {
  const cause = new AssertionError("1", "2");
  const wrapper = new Error("1 == 2", { cause });
  wrapper.code = "ERR_TEST_FAILURE";
  const output = await render([failure({ details: { error: wrapper } })]);
  assert.match(output, /AssertionError: 1 == 2/u);
  assert.doesNotMatch(output, /ERR_TEST_FAILURE/u);
});

test("a string cause keeps the outer Error and its stack", async () => {
  const outer = new Error("outer diagnostic", { cause: "root cause" });
  const output = await render([failure({ details: { error: outer } })]);
  assert.match(output, /^\[test-failure\] packages\/daemon\/test\/example\.test\.ts: a test$/mu);
  assert.match(output, /Error: outer diagnostic/u);
  assert.match(output, /node-test-failure-reporter\.test\.mjs/u);
  assert.doesNotMatch(output, /root cause/u);
});

test("a number cause keeps the outer Error and its stack", async () => {
  const outer = new Error("outer numeric diagnostic", { cause: 42 });
  const output = await render([failure({ details: { error: outer } })]);
  assert.match(output, /Error: outer numeric diagnostic/u);
  assert.match(output, /node-test-failure-reporter\.test\.mjs/u);
});

test("a wrapper around an Error with a primitive cause stops at the Error", async () => {
  const inner = new Error("assertion with primitive cause", { cause: "root" });
  const wrapper = new Error("test failed", { cause: inner });
  wrapper.code = "ERR_TEST_FAILURE";
  const output = await render([failure({ details: { error: wrapper } })]);
  assert.match(output, /Error: assertion with primitive cause/u);
  assert.doesNotMatch(output, /root/u);
});

test("a parent's bare 'test failed' does not add a second, empty failure", async () => {
  const parent = new Error("test failed");
  const output = await render([failure({ name: "parent", details: { error: parent } })]);
  assert.equal(output, "");
});

test("a failing file reports the file path and its own error", async () => {
  const output = await render([
    {
      type: "test:fail",
      data: { name: "packages/daemon/test/example.test.ts", nesting: 0, details: { error: new Error("load failed") } },
    },
  ]);
  assert.match(output, /^\[test-failure\] packages\/daemon\/test\/example\.test\.ts$/mu);
  assert.match(output, /load failed/u);
});

test("non-failure events produce no output", async () => {
  const output = await render([
    { type: "test:pass", data: { name: "ok" } },
    { type: "test:dequeue", data: { name: "next" } },
  ]);
  assert.equal(output, "");
});
