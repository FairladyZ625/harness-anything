import path from "node:path";
import {
  consentTypedCommandsV2,
  factRelationTypedCommandsV2,
  makeCompositeAuthoritySemanticCompilerV2,
  makeConsentSemanticCompilerV2,
  makeFactRelationSemanticCompilerV2,
  makeSessionExecutionReviewSemanticCompilerV2,
  makeTaskDecisionModuleSemanticCompilerV2,
  type ProductionAuthorityCompilerHostServices,
  sessionExecutionReviewTypedCommandsV2,
  taskDecisionModuleTypedCommandsV2
} from "@harness-anything/application";
import { createProductionCanonicalSemanticState } from "./production-authority-attempt-compiler.ts";
import { makeProductionScriptIngestSemanticCompiler } from "./production-authority-script-ingest.ts";

export function createProductionAuthoritySemanticCompiler(
  authoredRoot: string,
  hostServices: Pick<
    ProductionAuthorityCompilerHostServices,
    "readTaskPlanAdmissionSnapshot" | "readTaskReturnToIdeaSnapshot" | "readTaskWipSnapshot"
  >
) {
  const semanticState = createProductionCanonicalSemanticState(authoredRoot);
  const rootInput = {
    rootDir: path.dirname(authoredRoot),
    layoutOverrides: { authoredRoot: path.basename(authoredRoot) }
  };
  const taskExecutionAdmission = {
    ...(hostServices.readTaskWipSnapshot
      ? { taskWipSnapshot: async () => hostServices.readTaskWipSnapshot!(rootInput) }
      : {}),
    ...(hostServices.readTaskPlanAdmissionSnapshot
      ? {
        taskPlanSnapshot: (taskId: string) =>
          hostServices.readTaskPlanAdmissionSnapshot!(rootInput, taskId)
      }
      : {})
  };
  return makeCompositeAuthoritySemanticCompilerV2([{
    commandNames: ["script.scope-ingest"],
    compiler: makeProductionScriptIngestSemanticCompiler(authoredRoot)
  }, {
    commandNames: taskDecisionModuleTypedCommandsV2,
    compiler: makeTaskDecisionModuleSemanticCompilerV2({
      state: semanticState,
      ...taskExecutionAdmission,
      ...(hostServices.readTaskReturnToIdeaSnapshot
        ? {
          taskReturnToIdeaSnapshot: (taskId: string) =>
            hostServices.readTaskReturnToIdeaSnapshot!(rootInput, taskId)
        }
        : {})
    })
  }, {
    commandNames: factRelationTypedCommandsV2.filter((command) => command.startsWith("fact.")),
    compiler: makeFactRelationSemanticCompilerV2({ state: semanticState })
  }, {
    commandNames: factRelationTypedCommandsV2.filter((command) => command.startsWith("relation.")),
    compiler: makeFactRelationSemanticCompilerV2({ state: semanticState })
  }, {
    commandNames: sessionExecutionReviewTypedCommandsV2.filter((command) => command.startsWith("session.")),
    compiler: makeSessionExecutionReviewSemanticCompilerV2({ state: semanticState })
  }, {
    commandNames: sessionExecutionReviewTypedCommandsV2.filter((command) => command.startsWith("execution.")),
    compiler: makeSessionExecutionReviewSemanticCompilerV2({
      state: semanticState,
      ...taskExecutionAdmission
    })
  }, {
    commandNames: sessionExecutionReviewTypedCommandsV2.filter((command) => command.startsWith("completion.")),
    compiler: makeSessionExecutionReviewSemanticCompilerV2({ state: semanticState })
  }, {
    commandNames: sessionExecutionReviewTypedCommandsV2.filter((command) => command.startsWith("review.")),
    compiler: makeSessionExecutionReviewSemanticCompilerV2({ state: semanticState })
  }, {
    commandNames: consentTypedCommandsV2,
    compiler: makeConsentSemanticCompilerV2({ state: semanticState, rootInput })
  }]);
}
