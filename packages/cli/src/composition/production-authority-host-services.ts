import type {
  ProductionAuthorityCommandAction,
  ProductionAuthorityHostServices,
  TaskCompleteTransitionCommand,
  TaskSubmitTransitionCommand
} from "@harness-anything/application";
import { normalizeDecisionProposeAction } from "../cli/decision-propose-normalizer.ts";
import { normalizedFactSource } from "../cli/command-semantic-normalizer.ts";
import {
  productionAuthorityIngressFor
} from "../cli/command-spec/index.ts";
import type { ParsedCommand } from "../cli/types.ts";
import { decisionRelationRecord } from "../commands/core/decision-relation-record.ts";
import { materializeProposedDecision } from "../commands/core/decision-propose.ts";
import { materializedTaskPriorityWrites } from "../commands/core/decision-relate.ts";
import { injectDecisionAdmissionReadSet } from "../commands/core/decision-surface-admission.ts";
import { renderForceStatusAudit } from "../commands/core/task-lifecycle.ts";
import { loadDaemonIdentity } from "../commands/daemon/productization.ts";
import {
  buildAuthorityPresetTaskCreateWrites,
  shouldUsePresetAwareNewTask
} from "../commands/preset-task.ts";
import {
  readProjectHarnessSettings,
  shouldUseSettingsPresetAwareNewTask
} from "../commands/settings.ts";
import { readTaskWipSnapshot } from "../commands/task-wip-settings.ts";
import { readTaskPlanAdmissionSnapshot } from "../commands/task-plan-admission-snapshot.ts";
import { readTaskReturnToIdeaSnapshot } from "../commands/task-return-to-idea-snapshot.ts";
import { defaultCliAdapterProvider } from "./adapter-registry.ts";

type CliNewTaskAction = Extract<ParsedCommand["action"], { readonly kind: "new-task" }>;
type LoadedDaemonIdentity = ReturnType<typeof loadDaemonIdentity>;
type CliProductionAuthorityAction = Extract<
  ParsedCommand["action"],
  { readonly kind: ProductionAuthorityCommandAction["kind"] }
>;

type CliProductionAuthorityActionWithoutProjectedLifecycle = Exclude<
  CliProductionAuthorityAction,
  { readonly kind: "task-complete" | "task-submit" }
>;

const cliProductionActionsSatisfyHostContract = true satisfies
  CliProductionAuthorityActionWithoutProjectedLifecycle extends ProductionAuthorityCommandAction ? true : never;
void cliProductionActionsSatisfyHostContract;
const projectedCompleteActionSatisfiesHostContract = true satisfies
  TaskCompleteTransitionCommand extends ProductionAuthorityCommandAction ? true : never;
void projectedCompleteActionSatisfiesHostContract;
const projectedSubmitActionSatisfiesHostContract = true satisfies
  TaskSubmitTransitionCommand extends ProductionAuthorityCommandAction ? true : never;
void projectedSubmitActionSatisfiesHostContract;

export const productionAuthorityHostServices = {
  productionAuthorityIngressFor,
  normalizeDecisionProposeAction,
  normalizedFactSource,
  buildTaskCreateWrites: ({ rootInput, action, createdAt, provenance }) => {
    const cliAction = action as CliNewTaskAction;
    const settingsResult = readProjectHarnessSettings(rootInput, "new-task");
    if (!settingsResult.ok) {
      return {
        ok: false as const,
        ...(settingsResult.result.error?.code === undefined
          ? {}
          : { settingsErrorCode: settingsResult.result.error.code })
      };
    }
    const writes = shouldUsePresetAwareNewTask(cliAction)
      || shouldUseSettingsPresetAwareNewTask(settingsResult.settings)
      ? buildAuthorityPresetTaskCreateWrites(
          rootInput,
          cliAction,
          settingsResult.settings,
          createdAt,
          provenance
        )
      : defaultCliAdapterProvider().buildLocalTaskCreateWrites({
          taskId: cliAction.taskId!,
          title: cliAction.title,
          idempotencyKey: cliAction.idempotencyKey,
          allowManualId: cliAction.allowManualId,
          slug: cliAction.slug,
          parent: cliAction.parent,
          workKind: cliAction.workKind,
          riskTier: cliAction.riskTier,
          urgency: cliAction.urgency
        }, createdAt, provenance);
    return {
      ok: true as const,
      writes: cliAction.taskId
        ? injectDecisionAdmissionReadSet(writes, {
          rootInput,
          taskId: cliAction.taskId,
          packageSlug: cliAction.slug,
          surfaces: cliAction.surfaces
        })
        : writes
    };
  },
  materializeProposedDecision,
  decisionRelationRecord,
  materializedTaskPriorityWrites,
  renderForceStatusAudit,
  readTaskWipSnapshot,
  readTaskPlanAdmissionSnapshot,
  readTaskReturnToIdeaSnapshot,
  loadDaemonIdentity
} satisfies ProductionAuthorityHostServices<LoadedDaemonIdentity>;
