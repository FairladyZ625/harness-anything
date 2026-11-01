// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { DecisionProviderRecord } from "@harness-anything/kernel";
import { decisionProviderDoctorCheck } from "../src/decision-provider-doctor.ts";

const userRoot = "/tmp/ha-doctor-user",
  configPath = "/tmp/ha-doctor-user/decision-providers.json",
  checkedAt = "2026-11-01T00:00:00.000Z";

function provider(
  probe: DecisionProviderRecord["probe"],
  overrides: Partial<DecisionProviderRecord> = {},
): DecisionProviderRecord {
  return {
    schema: "decision-provider/v1",
    providerId: "openrouter-mammoth",
    name: "baseten/elephant-1:free",
    providerType: "decisions",
    vendor: "openrouter",
    model: "baseten/elephant-1:free",
    baseUrl: null,
    auth: { mode: "api-key", credentialRef: "credential:v1:test" },
    enabled: true,
    configurationRevision: 1,
    probe,
    ...overrides,
  };
}

test("doctor turns an unavailable configured model into a failing, actionable check", () => {
  const check = decisionProviderDoctorCheck({
    userRoot,
    configuredProviderId: "openrouter-mammoth",
    listProviders: () => [
      provider({ state: "failed", checkedAt, code: "decision_model_unavailable" }),
      provider({ state: "ready", checkedAt }, { providerId: "unused-ready" }),
    ],
  });
  assert.equal(check.id, "decisions-provider");
  assert.equal(check.status, "fail");
  assert.equal(check.count, 1);
  assert.match(check.summary, /openrouter-mammoth/u);
  assert.match(check.summary, /baseten\/elephant-1:free/u);
  assert.match(check.summary, /decision_model_unavailable/u);
  assert.match(check.next, /ha provider update openrouter-mammoth --model <available-model>/u);
  assert.match(check.next, /ha provider probe openrouter-mammoth/u);
  assert.ok(check.next.includes(configPath), check.next);
});

test("doctor warns when the configured provider's last probe failed for a non-model reason", () => {
  const check = decisionProviderDoctorCheck({
    userRoot,
    configuredProviderId: "openrouter-mammoth",
    listProviders: () => [provider({ state: "failed", checkedAt, code: "provider_credential_unavailable" })],
  });
  assert.equal(check.status, "warn");
  assert.equal(check.count, 1);
  assert.match(check.summary, /provider_credential_unavailable/u);
  assert.match(check.next, /ha provider probe openrouter-mammoth/u);
  assert.match(check.next, /api-key-file/u);
});

test("doctor reports a configured provider that is missing or disabled", () => {
  const missing = decisionProviderDoctorCheck({
    userRoot,
    configuredProviderId: "openrouter-mammoth",
    listProviders: () => [],
  });
  assert.equal(missing.status, "fail");
  assert.match(missing.summary, /openrouter-mammoth/u);
  assert.match(missing.next, /ha provider create/u);
  assert.ok(missing.next.includes(configPath), missing.next);

  const disabled = decisionProviderDoctorCheck({
    userRoot,
    configuredProviderId: "openrouter-mammoth",
    listProviders: () => [provider({ state: "ready", checkedAt }, { enabled: false })],
  });
  assert.equal(disabled.status, "fail");
  assert.match(disabled.summary, /disabled/u);
  assert.match(disabled.next, /ha provider update openrouter-mammoth --enable/u);
});

test("doctor leaves an unconfigured provider out of repository health", () => {
  const check = decisionProviderDoctorCheck({
    userRoot,
    configuredProviderId: null,
    listProviders: () => [provider({ state: "failed", checkedAt, code: "decision_model_unavailable" })],
  });
  assert.equal(check.status, "ok");
  assert.equal(check.count, 0);
  assert.doesNotMatch(check.summary, /openrouter-mammoth/u);
});

test("doctor treats an unprobed configured provider as unverified, not broken", () => {
  const check = decisionProviderDoctorCheck({
    userRoot,
    configuredProviderId: "openrouter-mammoth",
    listProviders: () => [provider({ state: "unknown" })],
  });
  assert.equal(check.status, "warn");
  assert.match(check.next, /ha provider probe openrouter-mammoth/u);
});

test("doctor reports a ready configured provider as ok", () => {
  const check = decisionProviderDoctorCheck({
    userRoot,
    configuredProviderId: "openrouter-mammoth",
    listProviders: () => [provider({ state: "ready", checkedAt })],
  });
  assert.equal(check.status, "ok");
  assert.equal(check.count, 0);
});

test("an unreadable provider file is a failure with the repair path, not a thrown doctor", () => {
  const check = decisionProviderDoctorCheck({
    userRoot,
    configuredProviderId: "openrouter-mammoth",
    listProviders: () => {
      throw new Error("Unexpected token in JSON");
    },
  });
  assert.equal(check.status, "fail");
  assert.match(check.summary, /could not be read/u);
  assert.match(check.summary, /Unexpected token/u);
  assert.ok(check.next.includes(configPath), check.next);
});
