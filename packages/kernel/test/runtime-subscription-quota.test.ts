// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  findExhaustedSubscriptionQuotaWindow,
  formatSubscriptionQuotaSummary,
  hasRecoveredSubscriptionQuota,
  validRuntimeSubscriptionQuota,
  type RuntimeSubscriptionQuotaV1,
} from "@harness-anything/kernel";
import { selectSubscriptionQuotaHeadlineWindow } from "../src/domain/runtime-subscription-quota.ts";

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
      scope: "primary",
      remainingFraction: 0.72,
      usedPercent: 28,
      resetsAt: "2026-11-21T15:00:00.000Z",
    },
    {
      id: "secondary",
      label: "7d",
      kind: "weekly",
      scope: "primary",
      remainingFraction: 0.4,
      usedPercent: 60,
      resetsAt: "2026-11-28T00:00:00.000Z",
    },
  ],
  credits: { remaining: 12.5, limit: 50, unlimited: false },
};

test("validRuntimeSubscriptionQuota accepts valid snapshots and rejects malformed, array-coerced, control-char, or oversized ones", () => {
  assert.equal(validRuntimeSubscriptionQuota(validQuota), true);
  const { credits: _omittedCredits, ...withoutCredits } = validQuota;
  const { scope: _omittedScope, ...windowWithoutScope } = validQuota.windows[0]!;
  assert.equal(
    validRuntimeSubscriptionQuota({
      ...withoutCredits,
      plan: null,
      windows: [{ ...windowWithoutScope, resetsAt: null }],
    }),
    true,
  );
  assert.equal(validRuntimeSubscriptionQuota(null), false);
  assert.equal(validRuntimeSubscriptionQuota({ ...validQuota, schemaVersion: 2 }), false);
  assert.equal(validRuntimeSubscriptionQuota({ ...validQuota, observedAt: "not-a-timestamp" }), false);
  assert.equal(validRuntimeSubscriptionQuota({ ...validQuota, extraField: true }), false);
  assert.equal(validRuntimeSubscriptionQuota({ ...validQuota, plan: "pro\ninjected" }), false);
  assert.equal(validRuntimeSubscriptionQuota({ ...validQuota, plan: "x".repeat(65) }), false);
  assert.equal(
    validRuntimeSubscriptionQuota({
      ...validQuota,
      windows: [{ ...validQuota.windows[0]!, kind: ["session"] }],
    }),
    false,
  );
  assert.equal(
    validRuntimeSubscriptionQuota({
      ...validQuota,
      windows: [{ ...validQuota.windows[0]!, scope: "invalid" }],
    }),
    false,
  );
  assert.equal(
    validRuntimeSubscriptionQuota({
      ...validQuota,
      windows: [{ ...validQuota.windows[0]!, label: "5h\tbad" }],
    }),
    false,
  );
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

test("findExhaustedSubscriptionQuotaWindow picks the latest future reset among primary windows and ignores auxiliary or tiny positive fractions", () => {
  const now = "2026-11-21T10:00:00.000Z";
  assert.equal(findExhaustedSubscriptionQuotaWindow(validQuota, now), null);

  const exhausted: RuntimeSubscriptionQuotaV1 = {
    ...validQuota,
    windows: [
      {
        id: "past",
        label: "Past",
        kind: "session",
        scope: "primary",
        remainingFraction: 0,
        usedPercent: 100,
        resetsAt: "2026-11-21T09:00:00.000Z",
      },
      {
        id: "earlier",
        label: "5h",
        kind: "session",
        scope: "primary",
        remainingFraction: 0,
        usedPercent: 100,
        resetsAt: "2026-11-21T14:00:00.000Z",
      },
      {
        id: "later",
        label: "7d",
        kind: "weekly",
        scope: "primary",
        remainingFraction: 0,
        usedPercent: 100,
        resetsAt: "2026-11-25T00:00:00.000Z",
      },
      {
        id: "code-review",
        label: "Code Review",
        kind: "bucket",
        scope: "auxiliary",
        remainingFraction: 0,
        usedPercent: 100,
        resetsAt: "2026-11-30T00:00:00.000Z",
      },
      {
        id: "tiny-positive",
        label: "Tiny",
        kind: "session",
        scope: "primary",
        remainingFraction: 0.004,
        usedPercent: 99.6,
        resetsAt: "2026-11-29T00:00:00.000Z",
      },
      {
        id: "no-reset",
        label: "No Reset",
        kind: "bucket",
        scope: "primary",
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

  // Auxiliary-only exhaustion (code-review or sonnet sub-bucket when Opus is configured) does not block.
  const auxExhausted: RuntimeSubscriptionQuotaV1 = {
    schemaVersion: 1,
    observedAt: now,
    source: "claude-oauth",
    plan: "max",
    windows: [
      {
        id: "five_hour",
        label: "5h",
        kind: "session",
        scope: "primary",
        remainingFraction: 0.5,
        usedPercent: 50,
        resetsAt: "2026-11-21T15:00:00.000Z",
      },
      {
        id: "seven_day_sonnet",
        label: "7d Sonnet",
        kind: "weekly",
        scope: "auxiliary",
        remainingFraction: 0,
        usedPercent: 100,
        resetsAt: "2026-11-27T00:00:00.000Z",
      },
    ],
  };
  assert.equal(findExhaustedSubscriptionQuotaWindow(auxExhausted, now, { models: ["claude-opus-5-5"] }), null);
  assert.equal(
    findExhaustedSubscriptionQuotaWindow(auxExhausted, now, { models: ["claude-sonnet-4-5"] })?.window.id,
    "seven_day_sonnet",
  );

  // AGY multi-family, dedicated sub-family (Argon/Carbon/Hydrogen), unknown buckets, and mixed-model accounts.
  const agyMultiFamily: RuntimeSubscriptionQuotaV1 = {
    schemaVersion: 1,
    observedAt: now,
    source: "agy-cli",
    plan: "Ultra",
    windows: [
      {
        id: "gemini-weekly",
        label: "Gemini · Weekly",
        kind: "weekly",
        scope: "primary",
        remainingFraction: 0.835,
        usedPercent: 16.5,
        resetsAt: "2026-11-22T00:00:00.000Z",
      },
      {
        id: "claude-7d",
        label: "Claude/GPT · 7d",
        kind: "weekly",
        scope: "primary",
        remainingFraction: 0,
        usedPercent: 100,
        resetsAt: "2026-11-28T00:00:00.000Z",
      },
      {
        id: "argon-weekly",
        label: "Argon · Weekly",
        kind: "weekly",
        scope: "primary",
        remainingFraction: 0,
        usedPercent: 100,
        resetsAt: "2026-11-26T00:00:00.000Z",
      },
      {
        id: "imagen-weekly",
        label: "Imagen · Weekly",
        kind: "weekly",
        scope: "primary",
        remainingFraction: 0,
        usedPercent: 100,
        resetsAt: "2026-11-29T00:00:00.000Z",
      },
    ],
  };
  // Exhausted Argon, Claude/GPT, and unknown Imagen buckets never cool down a Gemini Hydrogen/Carbon instance.
  assert.equal(findExhaustedSubscriptionQuotaWindow(agyMultiFamily, now, { models: ["gemini-4-hydrogen-low"] }), null);
  assert.equal(findExhaustedSubscriptionQuotaWindow(agyMultiFamily, now, { models: ["gemini-4-carbon-high"] }), null);
  // Argon model hits the dedicated Argon bucket, Claude hits Claude/GPT, Imagen hits unknown Imagen bucket.
  assert.equal(
    findExhaustedSubscriptionQuotaWindow(agyMultiFamily, now, { models: ["gemini-4-argon-high"] })?.window.id,
    "argon-weekly",
  );
  assert.equal(
    findExhaustedSubscriptionQuotaWindow(agyMultiFamily, now, { models: ["claude-opus-5-5"] })?.window.id,
    "claude-7d",
  );
  assert.equal(
    findExhaustedSubscriptionQuotaWindow(agyMultiFamily, now, { models: ["imagen-3"] })?.window.id,
    "imagen-weekly",
  );
  // Mixed-model instance (Gemini healthy + Claude exhausted) is NOT whole-instance exhausted.
  assert.equal(
    findExhaustedSubscriptionQuotaWindow(agyMultiFamily, now, {
      models: ["gemini-4-hydrogen-low", "claude-opus-5-5"],
    }),
    null,
  );
  // Mixed-model instance where EVERY configured model is exhausted returns the earliest model unblock time.
  assert.equal(
    findExhaustedSubscriptionQuotaWindow(agyMultiFamily, now, {
      models: ["gemini-4-argon-high", "claude-opus-5-5"],
    })?.resetAt,
    "2026-11-26T00:00:00.000Z",
  );
  // Provider-declared `models[]` on a bucket takes precedence over text inference.
  const explicitModelsQuota: RuntimeSubscriptionQuotaV1 = {
    schemaVersion: 1,
    observedAt: now,
    source: "agy-cli",
    plan: "Pro",
    windows: [
      {
        id: "pool-a",
        label: "Pool A",
        kind: "bucket",
        scope: "primary",
        models: ["gemini-4-hydrogen-low"],
        remainingFraction: 0.5,
        usedPercent: 50,
        resetsAt: "2026-11-22T00:00:00.000Z",
      },
      {
        id: "pool-b",
        label: "Pool B",
        kind: "bucket",
        scope: "primary",
        models: ["gemini-4-argon-low"],
        remainingFraction: 0,
        usedPercent: 100,
        resetsAt: "2026-11-26T00:00:00.000Z",
      },
    ],
  };
  assert.equal(validRuntimeSubscriptionQuota(explicitModelsQuota), true);
  assert.equal(
    findExhaustedSubscriptionQuotaWindow(explicitModelsQuota, now, { models: ["gemini-4-hydrogen-low"] }),
    null,
  );
  assert.equal(
    findExhaustedSubscriptionQuotaWindow(explicitModelsQuota, now, { models: ["gemini-4-argon-low"] })?.window.id,
    "pool-b",
  );

  // Credits-only and 0%-without-resetAt snapshots NEVER count as positive recovery.
  assert.equal(hasRecoveredSubscriptionQuota({ ...validQuota, windows: [] }, now), false);
  assert.equal(
    hasRecoveredSubscriptionQuota(
      {
        ...validQuota,
        windows: [{ ...validQuota.windows[0]!, remainingFraction: 0, usedPercent: 100, resetsAt: null }],
      },
      now,
    ),
    false,
  );
  assert.equal(hasRecoveredSubscriptionQuota(validQuota, now), true);

  // Headline selector ignores inapplicable buckets and expired windows.
  const headline = selectSubscriptionQuotaHeadlineWindow(agyMultiFamily, now, {
    models: ["gemini-4-hydrogen-low"],
  });
  assert.equal(headline?.window.id, "gemini-weekly");
  assert.equal(headline?.exhausted, false);
  const expiredHeadline = selectSubscriptionQuotaHeadlineWindow(onlyPast, now, { models: ["gpt-6-sol"] });
  assert.equal(expiredHeadline?.exhausted, false);
});

test("formatSubscriptionQuotaSummary renders plan, remaining percentages (including <1%), reset times, and credits", () => {
  assert.equal(formatSubscriptionQuotaSummary(undefined), "-");
  assert.equal(
    formatSubscriptionQuotaSummary(validQuota),
    "[pro] 5h 72% (resets 2026-11-21T15:00:00.000Z), 7d 40% (resets 2026-11-28T00:00:00.000Z), credits 12.5/50",
  );
  assert.equal(
    formatSubscriptionQuotaSummary({
      ...validQuota,
      plan: null,
      windows: [{ ...validQuota.windows[0]!, remainingFraction: 0.004, usedPercent: 99.6, resetsAt: null }],
      credits: { remaining: null, limit: null, unlimited: true },
    }),
    "5h <1%, credits unlimited",
  );
});
