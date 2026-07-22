// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_EXECUTION_CONSENT_TTL_MS,
  DEFAULT_MULTICA_STALE_TTL_MS,
  resolveExecutionConsentTtlMs,
  resolveMulticaStaleTtlMs
} from "../src/commands/project-policy-settings.ts";

test("execution consent TTL resolves default, YAML, then environment override", () => {
  withRoot((rootDir) => {
    assert.deepEqual(resolveExecutionConsentTtlMs(rootDir, {}), {
      ok: true,
      ttlMs: DEFAULT_EXECUTION_CONSENT_TTL_MS
    });
    writeSettings(rootDir, [
      "settings:",
      "  execution:",
      "    consentTtlMs: 7200000"
    ]);
    assert.deepEqual(resolveExecutionConsentTtlMs(rootDir, {}), { ok: true, ttlMs: 7_200_000 });
    assert.deepEqual(resolveExecutionConsentTtlMs(rootDir, {
      HARNESS_EXECUTION_CONSENT_TTL_MS: "3600000"
    }), { ok: true, ttlMs: 3_600_000 });
  });
});

test("execution consent TTL rejects invalid YAML and environment before use", () => {
  withRoot((rootDir) => {
    writeSettings(rootDir, [
      "settings:",
      "  execution:",
      "    consentTtlMs: 0"
    ]);
    const yaml = resolveExecutionConsentTtlMs(rootDir, {});
    assert.equal(yaml.ok, false);
    if (!yaml.ok) assert.match(yaml.result.error?.hint ?? "", /positive integer/u);
  });
  withRoot((rootDir) => {
    const env = resolveExecutionConsentTtlMs(rootDir, {
      HARNESS_EXECUTION_CONSENT_TTL_MS: ""
    });
    assert.equal(env.ok, false);
    if (!env.ok) assert.match(env.result.error?.hint ?? "", /HARNESS_EXECUTION_CONSENT_TTL_MS/u);
  });
});

test("Multica stale TTL resolves default, YAML, then environment override", () => {
  withRoot((rootDir) => {
    assert.deepEqual(resolveMulticaStaleTtlMs(rootDir, {}), {
      ok: true,
      ttlMs: DEFAULT_MULTICA_STALE_TTL_MS
    });
    writeSettings(rootDir, [
      "settings:",
      "  adapters:",
      "    multica:",
      "      staleTtlMs: 240000"
    ]);
    assert.deepEqual(resolveMulticaStaleTtlMs(rootDir, {}), { ok: true, ttlMs: 240_000 });
    assert.deepEqual(resolveMulticaStaleTtlMs(rootDir, {
      HARNESS_MULTICA_STALE_TTL_MS: "120000"
    }), { ok: true, ttlMs: 120_000 });
  });
});

test("Multica stale TTL rejects invalid YAML and environment before use", () => {
  withRoot((rootDir) => {
    writeSettings(rootDir, [
      "settings:",
      "  adapters:",
      "    multica:",
      "      staleTtlMs: nope"
    ]);
    const yaml = resolveMulticaStaleTtlMs(rootDir, {});
    assert.equal(yaml.ok, false);
    if (!yaml.ok) assert.match(yaml.result.error?.hint ?? "", /settings\.adapters\.multica\.staleTtlMs/u);
  });
  withRoot((rootDir) => {
    const env = resolveMulticaStaleTtlMs(rootDir, {
      HARNESS_MULTICA_STALE_TTL_MS: "-1"
    });
    assert.equal(env.ok, false);
    if (!env.ok) assert.match(env.result.error?.hint ?? "", /HARNESS_MULTICA_STALE_TTL_MS/u);
  });
});

function withRoot(run: (rootDir: string) => void): void {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-project-policy-"));
  try {
    run(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function writeSettings(rootDir: string, lines: ReadonlyArray<string>): void {
  const harnessDir = path.join(rootDir, "harness");
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(path.join(harnessDir, "harness.yaml"), `${lines.join("\n")}\n`, "utf8");
}
