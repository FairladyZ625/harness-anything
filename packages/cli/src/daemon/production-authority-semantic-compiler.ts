import {
  consentTypedCommandsV2,
  factRelationTypedCommandsV2,
  makeCompositeAuthoritySemanticCompilerV2,
  makeConsentSemanticCompilerV2,
  makeFactRelationSemanticCompilerV2,
  makeSessionExecutionReviewSemanticCompilerV2,
  makeTaskDecisionModuleSemanticCompilerV2,
  sessionExecutionReviewTypedCommandsV2,
  taskDecisionModuleTypedCommandsV2
} from "../../../application/src/index.ts";
import { createProductionCanonicalSemanticState } from "./production-authority-attempt-compiler.ts";
import { makeProductionScriptIngestSemanticCompiler } from "./production-authority-script-ingest.ts";

export function createProductionAuthoritySemanticCompiler(authoredRoot: string) {
  const semanticState = createProductionCanonicalSemanticState(authoredRoot);
  const rootInput = {
    rootDir: path.dirname(authoredRoot),
    layoutOverrides: { authoredRoot: path.basename(authoredRoot) }
  };
  return makeCompositeAuthoritySemanticCompilerV2([{
    commandNames: ["script.scope-ingest"],
    compiler: makeProductionScriptIngestSemanticCompiler(authoredRoot)
  }, {
    commandNames: taskDecisionModuleTypedCommandsV2,
    compiler: makeTaskDecisionModuleSemanticCompilerV2({ state: semanticState })
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
    compiler: makeSessionExecutionReviewSemanticCompilerV2({ state: semanticState })
  }, {
    commandNames: sessionExecutionReviewTypedCommandsV2.filter((command) => command.startsWith("review.")),
    compiler: makeSessionExecutionReviewSemanticCompilerV2({ state: semanticState })
  }, {
    commandNames: consentTypedCommandsV2,
    compiler: makeConsentSemanticCompilerV2({ state: semanticState, rootInput })
  }]);
}
import path from "node:path";
