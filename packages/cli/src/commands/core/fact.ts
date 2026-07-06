import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import type { FactWriteRejected } from "../../../../application/src/index.ts";
import { parseFactFlowRecords, type FactRecord, type WriteError } from "../../../../kernel/src/index.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";

type FactAction = Extract<ParsedCommand["action"], { readonly kind: "fact-list" | "fact-show" | "record-fact" | "fact-invalidate" }>;

export const runFactCommand: CommandRunner = (context, command) => {
  const action = command.action as FactAction;
  if (action.kind === "fact-list") return Effect.sync(() => runFactList(context.layoutInput, action));
  if (action.kind === "fact-show") return Effect.sync(() => runFactShow(context.layoutInput, action));
  if (action.kind === "fact-invalidate") {
    return context.factWriteService.invalidate({
      ownerTaskId: action.taskId,
      factId: action.factId,
      invalidatedByFactId: action.invalidatedByFactId,
      rationale: action.rationale,
      dryRun: action.dryRun
    }).pipe(
      Effect.match({
        onFailure: (error): CliResult => factFailure(action, error),
        onSuccess: (result): CliResult => ({
          ok: true,
          command: "fact-invalidate",
          taskId: result.taskId,
          factId: result.factId,
          factRef: result.ref,
          path: result.path,
          report: {
            schema: "fact-invalidate-cli-report/v1",
            dryRun: action.dryRun,
            ref: result.ref,
            invalidatedByFactId: result.invalidatedByFactId,
            relationId: result.relationId
          }
        })
      })
    );
  }
  return context.factWriteService.record({
    ownerTaskId: action.taskId,
    factId: action.factId,
    statement: action.statement,
    source: action.source,
    observedAt: action.observedAt,
    confidence: action.confidence,
    memoryClass: action.memoryClass,
    memoryTags: action.memoryTags,
    dryRun: action.dryRun
  }).pipe(
    Effect.match({
      onFailure: (error): CliResult => factFailure(action, error),
      onSuccess: (result): CliResult => ({
        ok: true,
        command: "record-fact",
        taskId: result.taskId,
        factId: result.factId,
        factRef: result.ref,
        path: result.path,
        report: {
          schema: "fact-record-cli-report/v1",
          dryRun: action.dryRun,
          ref: result.ref
        }
      })
    })
  );
};

function runFactList(rootInput: HarnessLayoutInput, action: Extract<FactAction, { readonly kind: "fact-list" }>): CliResult {
  const layout = resolveHarnessLayout(rootInput);
  const factsPath = layout.taskFactDocumentPath(action.taskId);
  const facts = readFacts(factsPath);
  return {
    ok: true,
    command: "fact-list",
    taskId: action.taskId,
    rows: facts.length,
    path: path.relative(layout.rootDir, factsPath).split(path.sep).join("/"),
    report: {
      schema: "fact-list-cli-report/v1",
      taskId: action.taskId,
      facts: facts.map((fact) => factReport(action.taskId, fact))
    }
  };
}

function runFactShow(rootInput: HarnessLayoutInput, action: Extract<FactAction, { readonly kind: "fact-show" }>): CliResult {
  const layout = resolveHarnessLayout(rootInput);
  const factsPath = layout.taskFactDocumentPath(action.taskId);
  const fact = readFacts(factsPath).find((record) => record.fact_id === action.factId);
  if (!fact) {
    return {
      ok: false,
      command: "fact-show",
      taskId: action.taskId,
      factId: action.factId,
      error: cliError(CliErrorCode.FactWriteRejected, `fact not found: ${action.factId}`)
    };
  }
  return {
    ok: true,
    command: "fact-show",
    taskId: action.taskId,
    factId: fact.fact_id,
    factRef: `fact/${action.taskId}/${fact.fact_id}`,
    path: path.relative(layout.rootDir, factsPath).split(path.sep).join("/"),
    report: {
      schema: "fact-show-cli-report/v1",
      fact: factReport(action.taskId, fact)
    }
  };
}

function readFacts(factsPath: string): ReadonlyArray<FactRecord> {
  if (!existsSync(factsPath)) return [];
  return parseFactFlowRecords(readFileSync(factsPath, "utf8"));
}

function factReport(taskId: string, fact: FactRecord): Record<string, unknown> {
  return {
    ref: `fact/${taskId}/${fact.fact_id}`,
    factId: fact.fact_id,
    statement: fact.statement,
    source: fact.source,
    observedAt: fact.observedAt,
    confidence: fact.confidence,
    memoryClass: fact.memoryClass,
    memoryTags: fact.memoryTags
  };
}

function factFailure(action: FactAction, error: FactWriteRejected | WriteError): CliResult {
  const reason = "_tag" in error && error._tag === "FactWriteRejected" ? error.reason : JSON.stringify(error);
  return {
    ok: false,
    command: action.kind,
    taskId: action.taskId,
    error: cliError(CliErrorCode.FactWriteRejected, reason)
  };
}
