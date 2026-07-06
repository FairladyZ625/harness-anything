import path from "node:path";
import {
  type DecisionWriteRejected
} from "../../../../application/src/index.ts";
import {
  type DecisionPackage,
  type WriteError
} from "../../../../kernel/src/index.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";

export function parseActor(value: string | undefined): DecisionPackage["arbiter"] | null {
  if (!value) return null;
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return null;
  const kind = value.slice(0, separator);
  if (kind !== "agent" && kind !== "human" && kind !== "system") return null;
  return { kind, id: value.slice(separator + 1) };
}

export function decisionResult(rootInput: HarnessLayoutInput, command: string, decisionId: string, state: string, dryRun: boolean): CliResult {
  const layout = resolveHarnessLayout(rootInput);
  const documentPath = layout.decisionDocumentPath(decisionId);
  return {
    ok: true,
    command,
    decisionId,
    decisionState: state,
    path: path.relative(layout.rootDir, documentPath).split(path.sep).join("/"),
    report: { schema: "decision-write-cli-report/v1", dryRun }
  };
}

export function decisionFailure(command: string, decisionId: string, error: DecisionWriteRejected | WriteError): CliResult {
  const reason = "_tag" in error && error._tag === "DecisionWriteRejected" ? error.reason : JSON.stringify(error);
  return {
    ok: false,
    command,
    decisionId,
    error: cliError(CliErrorCode.DecisionWriteRejected, reason)
  };
}
