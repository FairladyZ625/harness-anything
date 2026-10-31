// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  AttemptLedger,
  CloudDispatchRelay,
  CloudDispatchRelayError,
  costMicros,
  mask,
  relayPriceOf,
  usageOf,
  type UpstreamRequest,
} from "../src/runtime/cloud-dispatch-relay.ts";
import {
  assertContextBudget,
  estimateInputTokens,
  ModelSlotQueue,
  RuntimeBoundaryError,
  type SlotQueueOptions,
} from "../src/runtime/model-slot-queue.ts";

interface FakeTimer {
  readonly callback: () => void;
  readonly delayMs: number;
  cleared: boolean;
  unref: () => void;
}

function deterministicQueue(options: Omit<SlotQueueOptions, "now" | "scheduleTimeout" | "clearTimeout"> = {}) {
  let now = 100;
  const timers: FakeTimer[] = [];
  const queue = new ModelSlotQueue({
    ...options,
    now: () => now,
    scheduleTimeout: (callback, delayMs) => {
      const timer: FakeTimer = { callback, delayMs, cleared: false, unref: () => undefined };
      timers.push(timer);
      return timer as unknown as NodeJS.Timeout;
    },
    clearTimeout: (timer) => {
      (timer as unknown as FakeTimer).cleared = true;
    },
  });
  return {
    queue,
    timers,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    fire: (index: number) => timers[index]!.callback(),
  };
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

test("model slots rotate flows by least recently served and retain FIFO within each flow", async () => {
  const queue = new ModelSlotQueue({ globalCapacity: 1, perOwnerCapacity: 2, maxWaitMs: 1_000 });
  const order: string[] = [];
  await queue.acquire({ attemptId: "a1", ownerKey: "owner-a", flowKey: "flow-a" });
  const a2 = queue.acquire({ attemptId: "a2", ownerKey: "owner-a", flowKey: "flow-a" }).then(() => order.push("a2"));
  const b1 = queue.acquire({ attemptId: "b1", ownerKey: "owner-b", flowKey: "flow-b" }).then(() => order.push("b1"));
  const c1 = queue.acquire({ attemptId: "c1", ownerKey: "owner-c", flowKey: "flow-c" }).then(() => order.push("c1"));
  queue.release("a1");
  await b1;
  queue.release("b1");
  await c1;
  queue.release("c1");
  await a2;
  assert.deepEqual(order, ["b1", "c1", "a2"]);
  queue.release("a2");
  queue.close();
});

test("owner capacity skips a blocked flow head while global capacity is available", async () => {
  const queue = new ModelSlotQueue({ globalCapacity: 2, perOwnerCapacity: 1 });
  await queue.acquire({ attemptId: "a1", ownerKey: "owner-a", flowKey: "flow-a" });
  const blockedSameOwner = queue.acquire({ attemptId: "a2", ownerKey: "owner-a", flowKey: "flow-a" });
  const otherOwner = queue.acquire({ attemptId: "b1", ownerKey: "owner-b", flowKey: "flow-b" });
  await otherOwner;
  assert.equal(queue.position("a2"), 1);
  queue.release("a1");
  await blockedSameOwner;
  queue.release("a2");
  queue.release("b1");
  queue.close();
});

test("queue timeout removes the waiter and frees a later flow without wall-clock sleep", async () => {
  const { queue, timers, fire } = deterministicQueue({ globalCapacity: 1, perOwnerCapacity: 1, maxWaitMs: 500 });
  await queue.acquire({ attemptId: "held", ownerKey: "owner-a", flowKey: "flow-a" });
  const expired = queue.acquire({ attemptId: "expired", ownerKey: "owner-b", flowKey: "flow-b" });
  const next = queue.acquire({ attemptId: "next", ownerKey: "owner-c", flowKey: "flow-c" });
  const rejected = assert.rejects(expired, (error: unknown) => errorCode(error) === "SLOT_QUEUE_TIMEOUT");
  assert.equal(timers[1]!.delayMs, 500);
  fire(1);
  await rejected;
  queue.release("held");
  await next;
  assert.equal(queue.position("next"), 0);
  queue.release("next");
  queue.close();
});

test("queued time is observable but does not claim execution until slot grant", async () => {
  const { queue, advance } = deterministicQueue();
  await queue.acquire({ attemptId: "running", ownerKey: "owner-a", flowKey: "flow-a" });
  const queued = queue.acquire({ attemptId: "queued", ownerKey: "owner-b", flowKey: "flow-b" });
  advance(250);
  assert.equal(queue.snapshot().waiting[0]!.waitedMs, 250);
  assert.equal(queue.position("queued"), 1);
  queue.release("running");
  await queued;
  assert.equal(queue.position("queued"), 0);
  queue.release("queued");
  queue.close();
});

test("release cancels a queued attempt and close refuses future waits", async () => {
  const queue = new ModelSlotQueue({ globalCapacity: 1 });
  await queue.acquire({ attemptId: "running", ownerKey: "owner-a", flowKey: "flow-a" });
  const cancelled = queue.acquire({ attemptId: "waiting", ownerKey: "owner-b", flowKey: "flow-b" });
  const rejection = assert.rejects(cancelled, (error: unknown) => errorCode(error) === "SLOT_CANCELLED");
  queue.release("waiting");
  await rejection;
  queue.close();
  await assert.rejects(
    queue.acquire({ attemptId: "later", ownerKey: "owner-c", flowKey: "flow-c" }),
    /runtime is closing/u,
  );
});

test("context token estimate is conservative and explicit budget overflow rejects", () => {
  assert.equal(estimateInputTokens("你好abc"), 3);
  assert.equal(assertContextBudget("中文", { nCtx: 4, outputReserve: 2 }), 2);
  assert.throws(
    () => assertContextBudget("中文", { nCtx: 2, outputReserve: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeBoundaryError);
      assert.equal(error.code, "CONTEXT_BUDGET_EXCEEDED");
      assert.equal(error.status, 413);
      return true;
    },
  );
});

test("queue rejects malformed requests and duplicate attempt ids", async () => {
  const queue = new ModelSlotQueue();
  assert.throws(
    () => queue.acquire({ attemptId: "", ownerKey: "owner", flowKey: "flow" }),
    (error: unknown) => errorCode(error) === "INVALID_SLOT_REQUEST",
  );
  await queue.acquire({ attemptId: "same", ownerKey: "owner", flowKey: "flow" });
  await assert.rejects(
    queue.acquire({ attemptId: "same", ownerKey: "owner", flowKey: "flow" }),
    (error: unknown) => errorCode(error) === "SLOT_DUPLICATE",
  );
  queue.release("same");
  queue.close();
});

const price = { inputPerMillion: 2, cacheReadPerMillion: 0.1, outputPerMillion: 10 };

test("relay price table conversion and usage parser preserve micro-dollar arithmetic", () => {
  assert.deepEqual(relayPriceOf("gpt-6.1-sol"), price);
  assert.throws(
    () => relayPriceOf("unpriced-model"),
    (error: unknown) => errorCode(error) === "MODEL_UNPRICED",
  );
  assert.equal(costMicros(price, { input: 1_000, cachedInput: 500, output: 1_000 }), 11_050);
  assert.deepEqual(
    usageOf(
      JSON.stringify({
        usage: { input_tokens: 1_000, output_tokens: 500, input_tokens_details: { cached_tokens: 400 } },
      }),
      "application/json",
    ),
    { input: 1_000, cachedInput: 400, output: 500 },
  );
  assert.throws(() => usageOf("not json", "application/json"), /provider returned invalid JSON/u);
  assert.equal(
    mask("key=abcdefgh123 Bearer provider-secret", ["abcdefgh123", "provider-secret"]),
    "key=[REDACTED] Bearer [REDACTED]",
  );
});

test("ledger reserves concurrent worst cases, settles reported usage and estimates unknown outcomes", () => {
  const ledger = new AttemptLedger(price, 2_500, 100);
  const first = ledger.admit(200)!;
  const second = ledger.admit(200)!;
  assert.ok(first);
  assert.ok(second);
  assert.equal(ledger.admit(200), null);
  ledger.send(first);
  ledger.settleUsage(first, { input: 100, cachedInput: 0, output: 20 });
  assert.equal(ledger.costMicros, 400);
  ledger.send(second);
  assert.equal(ledger.status, "estimated");
  ledger.keep(second);
  assert.equal(ledger.status, "estimated");
  assert.ok(ledger.costMicros > 400);

  const overBudget = new AttemptLedger(price, 2_500, 100);
  const billed = overBudget.admit(200)!;
  overBudget.send(billed);
  overBudget.settleUsage(billed, { input: 1_000, cachedInput: 0, output: 200 });
  assert.equal(overBudget.costMicros, 4_000);
  assert.equal(overBudget.admit(200), null, "reported overrun blocks later provider requests");
});

async function postRelay(baseUrl: string, token: string, payload: object): Promise<{ status: number; body: string }> {
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.text() };
}

test("relay isolates provider key, clamps output and settles usage through the attempt token", async (t) => {
  let forwarded: UpstreamRequest | undefined;
  const relay = new CloudDispatchRelay({
    allowedHosts: ["provider.example"],
    maxGenerations: 2,
    outputCapTokens: 100,
    upstream: async (request) => {
      forwarded = request;
      return {
        status: 200,
        type: "application/json",
        body: Buffer.from(JSON.stringify({ usage: { input_tokens: 100, output_tokens: 20 }, keyEcho: request.key })),
      };
    },
  });
  t.after(() => relay.close());
  await relay.start();
  const registered = relay.register({
    attemptId: "attempt-isolated",
    targetBaseUrl: "https://provider.example/v1",
    model: "gpt-6.1-sol",
    keyFor: async () => "real-provider-key",
    price,
    budgetMicros: 10_000,
  });
  assert.match(registered.token, /^[a-f\d]{64}$/u);
  assert.match(registered.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
  const success = await postRelay(registered.baseUrl, registered.token, {
    model: "gpt-6.1-sol",
    max_output_tokens: 500,
  });
  assert.equal(success.status, 200);
  assert.equal(success.body.includes("real-provider-key"), false);
  assert.equal((JSON.parse(forwarded!.body.toString("utf8")) as { max_output_tokens: number }).max_output_tokens, 100);
  assert.equal(forwarded!.key, "real-provider-key");
  assert.deepEqual(relay.settlement("attempt-isolated"), { actualMicros: "400", costStatus: "reported" });
  assert.equal((await postRelay(registered.baseUrl, "wrong-attempt-token", { model: "gpt-6.1-sol" })).status, 401);
});

test("relay rejects unregistered routes and models before provider access", async (t) => {
  let keyReads = 0;
  const relay = new CloudDispatchRelay({
    allowedHosts: ["provider.example"],
    upstream: async () => {
      throw new Error("must not call upstream");
    },
  });
  t.after(() => relay.close());
  await relay.start();
  const registration = relay.register({
    attemptId: "attempt-route",
    targetBaseUrl: "https://provider.example/v1",
    model: "gpt-6.1-sol",
    keyFor: async () => {
      keyReads++;
      return "real-provider-key";
    },
  });
  assert.equal((await postRelay(registration.baseUrl, registration.token, { model: "different-model" })).status, 403);
  const wrongRoute = await fetch(`${registration.baseUrl}/not-responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${registration.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-6.1-sol" }),
  });
  assert.equal(wrongRoute.status, 403);
  assert.equal(keyReads, 0);
  assert.throws(
    () =>
      relay.register({
        attemptId: "bad-target",
        targetBaseUrl: "https://other.example/v1",
        model: "gpt-6.1-sol",
        keyFor: async () => "real-provider-key",
      }),
    (error: unknown) => errorCode(error) === "RELAY_REFUSED",
  );
});

test("relay settles provider overruns and blocks the next request at the budget boundary", async (t) => {
  let calls = 0;
  const relay = new CloudDispatchRelay({
    allowedHosts: ["provider.example"],
    outputCapTokens: 100,
    upstream: async () => {
      calls++;
      return {
        status: 200,
        type: "application/json",
        body: Buffer.from(JSON.stringify({ usage: { input_tokens: 1_000, output_tokens: 200 } })),
      };
    },
  });
  t.after(() => relay.close());
  await relay.start();
  const registration = relay.register({
    attemptId: "attempt-budget",
    targetBaseUrl: "https://provider.example/v1",
    model: "gpt-6.1-sol",
    keyFor: async () => "real-provider-key",
    price,
    budgetMicros: 2_500,
  });
  const first = await postRelay(registration.baseUrl, registration.token, { model: "gpt-6.1-sol" });
  const second = await postRelay(registration.baseUrl, registration.token, { model: "gpt-6.1-sol" });
  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
  assert.match(second.body, /budget_exceeded/u);
  assert.equal(calls, 1);
  assert.equal(relay.settlement("attempt-budget")!.actualMicros, "4000");
  assert.ok(relay.usage("attempt-budget")!.failures.includes("budget-exceeded"));
});

test("relay fuses the configured maximum generation count", async (t) => {
  let calls = 0;
  const relay = new CloudDispatchRelay({
    allowedHosts: ["provider.example"],
    maxGenerations: 1,
    upstream: async () => {
      calls++;
      return { status: 200, type: "application/json", body: Buffer.from("{}") };
    },
  });
  t.after(() => relay.close());
  await relay.start();
  const registration = relay.register({
    attemptId: "attempt-generations",
    targetBaseUrl: "https://provider.example/v1",
    model: "gpt-6.1-sol",
    keyFor: async () => "real-provider-key",
  });
  assert.equal((await postRelay(registration.baseUrl, registration.token, { model: "gpt-6.1-sol" })).status, 200);
  const denied = await postRelay(registration.baseUrl, registration.token, { model: "gpt-6.1-sol" });
  assert.equal(denied.status, 429);
  assert.match(denied.body, /generation_limit/u);
  assert.equal(calls, 1);
});

test("relay counts accepted generations and releases only its own token registration", async (t) => {
  const relay = new CloudDispatchRelay({
    allowedHosts: ["provider.example"],
    upstream: async () => ({ status: 400, type: "application/json", body: Buffer.from("{}") }),
  });
  t.after(() => relay.close());
  await relay.start();
  const first = relay.register({
    attemptId: "attempt-one",
    targetBaseUrl: "https://provider.example/v1",
    model: "m1",
    keyFor: async () => "real-provider-key",
  });
  const second = relay.register({
    attemptId: "attempt-two",
    targetBaseUrl: "https://provider.example/v1",
    model: "m2",
    keyFor: async () => "real-provider-key",
  });
  relay.release("attempt-one");
  assert.equal(relay.usage("attempt-one"), null);
  assert.ok(relay.usage("attempt-two"));
  assert.equal((await postRelay(second.baseUrl, first.token, { model: "m2" })).status, 401);
  assert.equal((await postRelay(second.baseUrl, second.token, { model: "m2" })).status, 400);
});

test("relay registration validates pricing pair and token lifecycle", async (t) => {
  const relay = new CloudDispatchRelay({ allowedHosts: ["provider.example"] });
  t.after(() => relay.close());
  await relay.start();
  assert.throws(
    () =>
      relay.register({
        attemptId: "incomplete-price",
        targetBaseUrl: "https://provider.example/v1",
        model: "m",
        keyFor: async () => "real-provider-key",
        price,
      }),
    (error: unknown) => error instanceof CloudDispatchRelayError && error.code === "RELAY_REFUSED",
  );
});
