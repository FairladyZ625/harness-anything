import { normalizeDecisionProposeAction } from "../../src/cli/decision-propose-normalizer.ts";
import { normalizedFactSource } from "../../src/cli/command-semantic-normalizer.ts";
import { productionAuthorityIngressFor } from "../../src/cli/command-spec/index.ts";
import { decisionRelationRecord } from "../../src/commands/core/decision-relation-record.ts";
import { materializeProposedDecision } from "../../src/commands/core/decision-propose.ts";
import { materializedTaskPriorityWrites } from "../../src/commands/core/decision-relate.ts";
import { renderForceStatusAudit } from "../../src/commands/core/task-lifecycle.ts";
import { loadDaemonIdentity } from "../../src/commands/daemon/productization.ts";
import {
  buildAuthorityPresetTaskCreateWrites,
  shouldUsePresetAwareNewTask
} from "../../src/commands/preset-task.ts";
import {
  readProjectHarnessSettings,
  shouldUseSettingsPresetAwareNewTask
} from "../../src/commands/settings.ts";
import { defaultCliAdapterProvider } from "../../src/composition/adapter-registry.ts";

/** Parent-commit oracle: this is the pre-injection call graph expressed as one test-only object. */
export const directProductionAuthorityHostServices = {
  productionAuthorityIngressFor,
  normalizeDecisionProposeAction,
  normalizedFactSource,
  buildTaskCreateWrites: ({ rootInput, action, createdAt, provenance }: any) => {
    const settingsResult = readProjectHarnessSettings(rootInput, "new-task");
    if (!settingsResult.ok) {
      return {
        ok: false as const,
        ...(settingsResult.result.error?.code === undefined
          ? {}
          : { settingsErrorCode: settingsResult.result.error.code })
      };
    }
    const writes = shouldUsePresetAwareNewTask(action)
      || shouldUseSettingsPresetAwareNewTask(settingsResult.settings)
      ? buildAuthorityPresetTaskCreateWrites(rootInput, action, settingsResult.settings, createdAt, provenance)
      : defaultCliAdapterProvider().buildLocalTaskCreateWrites({
          taskId: action.taskId,
          title: action.title,
          allowManualId: action.allowManualId,
          slug: action.slug,
          parent: action.parent,
          workKind: action.workKind,
          riskTier: action.riskTier,
          urgency: action.urgency
        }, createdAt, provenance);
    return { ok: true as const, writes };
  },
  materializeProposedDecision,
  decisionRelationRecord,
  materializedTaskPriorityWrites,
  renderForceStatusAudit,
  loadDaemonIdentity
};
