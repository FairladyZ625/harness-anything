import type { JsonObject } from "../../daemon/src/protocol/json-rpc-types.ts";
import { runtimeRejected } from "./cli-runtime-auth.ts";
import { waitForRuntime } from "./cli-runtime-wait.ts";
import type { AgentCreateAction } from "./cli-types.ts";
import type { ThinCommand } from "./cli/thin-command.ts";
import { consumeKnownError, runCommandThroughDaemon } from "./daemon/client.ts";
import { randomUUID } from "node:crypto";

export async function runAgentCreate(
  command: ThinCommand,
  writeActivity: (text: string) => void,
): Promise<JsonObject> {
  const action = command.action as AgentCreateAction,
    designerPrompt = agentDesignerPrompt(action.prompt),
    spawned = await runCommandThroughDaemon({
      ...command,
      method: "repo.agentRuntime.spawn",
      action: {
        kind: "runtime-run",
        runtimeInstanceId: action.runtimeInstanceId,
        agentId: action.agentId,
        prompt: designerPrompt,
        cwd: action.cwd,
        taskId: action.taskId ?? null,
        ...(action.effort ? { effort: action.effort } : {}),
        ...(action.model ? { model: action.model } : {}),
        idempotencyKey: `agent-create-${randomUUID()}`,
      },
    });
  if (spawned.ok !== true || typeof spawned.runtimeSessionId !== "string")
    return spawned;
  const settled = await waitForRuntime(
    command,
    spawned.runtimeSessionId,
    !command.json,
    writeActivity,
    spawned,
  );
  if (
    settled.outcome !== "succeeded" ||
    !settled.result ||
    typeof settled.result !== "object" ||
    typeof (settled.result as Record<string, unknown>).text !== "string"
  )
    return runtimeRejected(
      "agent-create",
      "agent_declaration_missing",
      "The designer did not return a succeeded structured declaration; rerun ha agent create " +
        "with a requirement that asks for one JSON object.",
    );
  let declaration: Record<string, unknown>;
  try {
    const parsed = JSON.parse(
      String((settled.result as Record<string, unknown>).text),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("declaration must be a JSON object");
    declaration = parsed as Record<string, unknown>;
  } catch (error) {
    consumeKnownError(error);
    return runtimeRejected(
      "agent-create",
      "agent_declaration_invalid",
      "The designer result was not one JSON object; rerun ha agent create and require exactly " +
        "one agent-declaration/v1 JSON object.",
    );
  }
  const validation = await runCommandThroughDaemon({
    ...command,
    method: "repo.task.run",
    action: {
      kind: "agent-validate",
      declaration,
      declarationSource: "runtime-result",
    },
  });
  if (validation.ok !== true || typeof validation.evidence !== "string")
    return runtimeRejected(
      "agent-create",
      "agent_validation_failed",
      "ha agent validate could not produce a validation report; rerun ha agent create after checking the daemon.",
    );
  const validationReport = JSON.parse(validation.evidence) as Record<
    string,
    unknown
  >;
  if (validationReport.valid !== true)
    return runtimeRejected(
      "agent-create",
      "agent_declaration_invalid",
      `ha agent validate rejected the declaration; fix the reported fields and rerun ha agent ` +
        `create. ${JSON.stringify(validationReport.issues ?? [])}`,
    );
  const installation = await runCommandThroughDaemon({
    ...command,
    method: "repo.task.run",
    action: {
      kind: "agent-install",
      declaration,
      declarationSource: "runtime-result",
      generatedOnly: true,
      validated: true,
    },
  });
  if (installation.ok !== true) return installation;
  return {
    schema: "command-receipt/v2",
    ok: true,
    command: "agent-create",
    outcome: "succeeded",
    designerAgentId: action.agentId,
    runtimeSessionId: spawned.runtimeSessionId,
    dispatchId: spawned.dispatchId,
    declaration: declaration as JsonObject,
    validation: validationReport as JsonObject,
    installation,
    result: settled.result,
    summary: `agent-create: installed ${String(declaration.id)}`,
    exitCode: 0,
  };
}

function agentDesignerPrompt(requirement: string): string {
  return [
    `# Agent declaration protocol`,
    `Return exactly one JSON object and no Markdown, code fences, or prose.`,
    `The object must contain schema exactly "agent-declaration/v1", plus id, name, instructions, ` +
      `runtime_type, and optional role (worker or commander) and model. Do not omit schema.`,
    `The harness will validate and install the declaration; do not run commands or install it yourself.`,
    `# Agent requirement`,
    requirement,
  ].join("\n\n");
}
