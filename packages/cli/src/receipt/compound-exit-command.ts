import { resolveCompoundReceiptExit } from "@harness-anything/daemon";
import { renderCompoundCliExit } from "./exit.ts";

export async function runCompoundReceiptExitCommand(argv: ReadonlyArray<string>): Promise<number | undefined> {
  if (argv[0] !== "compound-receipt" || argv[1] !== "exit") return undefined;
  const stateDirectory = required(argv, "--state-dir");
  const workspaceId = required(argv, "--workspace-id");
  const viewId = required(argv, "--view-id");
  const opId = required(argv, "--op-id");
  const waiterId = required(argv, "--waiter-id");
  const resultToken = required(argv, "--result-token");
  const input = stateDirectory && workspaceId && viewId && opId && waiterId && resultToken
    ? await resolveCompoundReceiptExit({ stateDirectory, workspaceId, viewId, opId, waiterId, resultToken })
    : { kind: "USAGE_ERROR" as const };
  return emitCompoundExit(renderCompoundCliExit(input), argv.includes("--json"));
}

function required(argv: ReadonlyArray<string>, name: string): string | undefined {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function emitCompoundExit(output: ReturnType<typeof renderCompoundCliExit>, json: boolean): number {
  if (json) console.log(JSON.stringify(output.json));
  else console.error(output.stderr);
  return output.exitCode;
}
