// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeProjectionLineEndings } from "./generate-daemon-status-vocabulary.mjs";
import {
  generateTaskActionProtocolProjection,
  projectSettingsFields,
  projectTaskActions,
  renderSettingsFieldProtocolProjection,
  renderTaskActionProtocolProjection,
  renderTaskCreateProjection,
} from "./generate-task-action-protocol.mjs";

const generatedSource = readFileSync(
    new URL("../packages/preset/src/task-action-projection.generated.ts", import.meta.url),
    "utf8",
  ),
  generatedCreateSource = readFileSync(
    new URL("../packages/preset/src/task-create-projection.generated.ts", import.meta.url),
    "utf8",
  ),
  generatedSettingsSource = readFileSync(
    new URL("../packages/preset/src/settings-field-projection.generated.ts", import.meta.url),
    "utf8",
  ),
  presetCommandContractSource = readFileSync(
    new URL("../packages/preset/src/preset-command-contract.ts", import.meta.url),
    "utf8",
  );

test("Task Action transport has one current build-time projection", async () => {
  await assert.doesNotReject(() => generateTaskActionProtocolProjection(true));
  assert.equal(await renderTaskActionProtocolProjection(), normalizeProjectionLineEndings(generatedSource));
  assert.equal(await renderTaskCreateProjection(), normalizeProjectionLineEndings(generatedCreateSource));
  assert.equal(await renderSettingsFieldProtocolProjection(), normalizeProjectionLineEndings(generatedSettingsSource));
  assert.match(presetCommandContractSource, /from "\.\/task-action-projection\.generated\.ts"/u);
  assert.match(presetCommandContractSource, /from "\.\/task-create-projection\.generated\.ts"/u);
  assert.match(presetCommandContractSource, /from "\.\/settings-field-projection\.generated\.ts"/u);
  assert.doesNotMatch(presetCommandContractSource, /task-action-projection:generated/u);
  assert.deepEqual(
    projectTaskActions().actions.map(({ id }) => id),
    ["create", "start", "transition", "submit", "adjudicate", "review", "consent", "complete"],
  );
  assert.deepEqual(
    projectSettingsFields().actionInputs.map(({ field }) => field),
    [
      "defaultVertical",
      "defaultPreset",
      "defaultProfile",
      "roles",
      "workerPermissionsMode",
      "reviewIndependence",
      "decisionReviewRequirement",
      "reviewPathReviewers",
      "reviewReturnBudget",
      "decisionsProvider",
      "decisionsEnabledPoints",
      "locale",
      "guiConnectTimeoutMs",
      "guiRequestTimeoutMs",
      "overviewWatchedActivityDays",
      "taskScaffold",
      "repositoryScaffold",
      "deliveryRequireMerged",
      "deliveryTargetBranch",
      "deliveryTargetRef",
      "hostingProvider",
      "hostingHost",
      "closeoutProfile",
      "closeoutReview",
      "closeoutConsent",
      "closeoutFactDisposition",
      "agendaPinLimit",
      "wipLimit",
      "rootThreshold",
      "worktreeSetup",
      "worktreeSetupStepTimeoutMs",
      "taskAssignmentTtlMs",
      "fleetClaimScope",
      "runtimeAllowedInstances",
      "runtimeDispatchUsageLimit",
      "runtimeProviderMaxRetries",
      "runtimeProviderRoundBackoffBaseSeconds",
      "runtimeProviderRoundBackoffMaxSeconds",
      "runtimeProviderCooldownBaseSeconds",
      "runtimeProviderCooldownMaxSeconds",
      "runtimeProviderFreezeAfter",
      "runtimeProviderFreezeDurationSeconds",
      "runtimeProviderMaxWaitSeconds",
      "runtimeProviderHandshakeTimeoutMs",
      "scheduleAdmissionWindowMs",
      "storageBackupExecutionLimitMs",
      "restoreDrillRetention",
      "dispatchArchiveRetentionDays",
      "dispatchArchiveRetentionBytes",
      "gatesFromDocument",
      "gatesDraft",
      "expectedVersion",
      "idempotencyKey",
    ],
  );
});

test("Task Action transport projection is readable source without compression or elision", async () => {
  const rendered = [
    await renderTaskActionProtocolProjection(),
    await renderTaskCreateProjection(),
    await renderSettingsFieldProtocolProjection(),
  ].join("\n");
  assert.match(rendered, /export const taskActionDescriptorProjection = \{\n/u);
  assert.match(rendered, /export const taskCreateDescriptorProjection = \{\n/u);
  assert.match(rendered, /export const settingsFieldProtocolProjection = \{\n/u);
  assert.doesNotMatch(rendered, /zlib|brotli|base64/iu);
  for (const field of projectTaskActions().actions.flatMap((action) => action.input.fields)) {
    assert.ok(Object.hasOwn(field, "type"), `${field.field} must project type`);
    assert.ok(Object.hasOwn(field, "required"), `${field.field} must project required`);
    if (field.cli) assert.ok(Object.hasOwn(field.cli, "error"), `${field.field} must project cli.error`);
  }
  assert.equal(
    rendered
      .split("\n")
      .filter((line) => line.length > 120)
      .join("\n"),
    "",
  );
});
