// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  findExhaustedSubscriptionQuotaWindow,
  formatSubscriptionQuotaSummary,
  validRuntimeSubscriptionQuota,
  type RuntimeSubscriptionQuotaV1,
} from "@harness-anything/kernel";

const validQuota: RuntimeSubscriptionQuotaV1 = {
  schemaVersion: 1,
  observedAt: "2026-11-21T10:00:00.000Z",
  source: "codex-oauth",
  plan: "pro",
  windows: [
    {
      id: "primary",
      label: "5h",
      kind: "session",
      remainingFraction: 0.72,
      usedPercent: 28,
      resetsAt: "2026-11-21T15:00:00.000Z",
    },
    {
      id: "secondary",
      label: "7d",
      kind: "weekly",
      remainingFraction: 0.4,
      usedPercent: 60,
      resetsAt: "2026-11-28T00:00:00.000Z",
    },
  ],
  credits: { remaining: 12.5, limit: 50, unlimited: false },
};

test("validRuntimeSubscriptionQuota accepts valid snapshots and rejects malformed ones", () => {
  assert.equal(validRuntimeSubscriptionQuota(validQuota), true);
  const { credits: _omittedCredits, ...withoutCredits } = validQuota;
  assert.equal(
    validRuntimeSubscriptionQuota({
      ...withoutCredits,
      plan: null,
      windows: [{ ...validQuota.windows[0]!, resetsAt: null }],
    }),
    true,
  );
  assert.equal(validRuntimeSubscriptionQuota(null), false);
  assert.equal(validRuntimeSubscriptionQuota({ ...validQuota, schemaVersion: 2 }), false);
  assert.equal(validRuntimeSubscriptionQuota({ ...validQuota, observedAt: "not-a-timestamp" }), false);
  assert.equal(validRuntimeSubscriptionQuota({ ...validQuota, extraField: true }), false);
  assert.equal(
    validRuntimeSubscriptionQuota({
      ...validQuota,
      windows: [{ ...validQuota.windows[0]!, remainingFraction: 1.5 }],
    }),
    false,
  );
  assert.equal(
    validRuntimeSubscriptionQuota({
      ...validQuota,
      windows: [{ ...validQuota.windows[0]!, usedPercent: -1 }],
    }),
    false,
  );
  assert.equal(
    validRuntimeSubscriptionQuota({
      ...validQuota,
      windows: [{ ...validQuota.windows[0]!, kind: "daily" }],
    }),
    false,
  );
  assert.equal(
    validRuntimeSubscriptionQuota({
      ...validQuota,
      credits: { remaining: Number.NaN, limit: null, unlimited: false },
    }),
    false,
  );
});

test("findExhaustedSubscriptionQuotaWindow picks the latest future reset among exhausted windows", () => {
  const now = "2026-11-21T10:00:00.000Z";
  assert.equal(findExhaustedSubscriptionQuotaWindow(validQuota, now), null);

  const exhausted: RuntimeSubscriptionQuotaV1 = {
    ...validQuota,
    windows: [
      {
        id: "past",
        label: "Past",
        kind: "session",
        remainingFraction: 0,
        usedPercent: 100,
        resetsAt: "2026-11-21T09:00:00.000Z",
      },
      {
        id: "earlier",
        label: "5h",
        kind: "session",
        remainingFraction: 0,
        usedPercent: 100,
        resetsAt: "2026-11-21T14:00:00.000Z",
      },
      {
        id: "later",
        label: "7d",
        kind: "weekly",
        remainingFraction: 0,
        usedPercent: 100,
        resetsAt: "2026-11-25T00:00:00.000Z",
      },
      {
        id: "healthy-even-later",
        label: "Model",
        kind: "bucket",
        remainingFraction: 0.2,
        usedPercent: 80,
        resetsAt: "2026-11-29T00:00:00.000Z",
      },
      {
        id: "no-reset",
        label: "No Reset",
        kind: "bucket",
        remainingFraction: 0,
        usedPercent: 100,
        resetsAt: null,
      },
    ],
  };

  const match = findExhaustedSubscriptionQuotaWindow(exhausted, now);
  assert.equal(match?.window.id, "later");
  assert.equal(match?.resetAt, "2026-11-25T00:00:00.000Z");

  // Past reset times are ignored when `now` is provided.
  const onlyPast: RuntimeSubscriptionQuotaV1 = {
    ...validQuota,
    windows: [exhausted.windows[0]!],
  };
  assert.equal(findExhaustedSubscriptionQuotaWindow(onlyPast, now), null);
});

test("formatSubscriptionQuotaSummary renders plan, remaining percentages, reset times, and credits", () => {
  assert.equal(formatSubscriptionQuotaSummary(undefined), "-");
  assert.equal(
    formatSubscriptionQuotaSummary(validQuota),
    "[pro] 5h 72% (resets 2026-11-21T15:00:00.000Z), 7d 40% (resets 2026-11-28T00:00:00.000Z), credits 12.5/50",
  );
  assert.equal(
    formatSubscriptionQuotaSummary({
      ...validQuota,
      plan: null,
      windows: [{ ...validQuota.windows[0]!, resetsAt: null }],
      credits: { remaining: null, limit: null, unlimited: true },
    }),
    "5h 72%, credits unlimited",
  );
});
