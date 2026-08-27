import type { AgentRuntimeOverviewResult } from "../../../daemon/src/agent-runtime-contract.ts";
import type { GuiActionResult } from "../api/renderer-dto.ts";
import { isRendererRecord, rendererErrorHint } from "./result-validation.ts";

export interface RuntimeSpawnInput {
  readonly runtimeInstanceId?: string;
  readonly agentId?: string;
  readonly squadId?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly permissionMode?: string;
  readonly cwd: { readonly scope: "repo-root" } | { readonly scope: "repo-relative"; readonly path: string };
  readonly prompt: string;
  readonly taskId: string | null;
  readonly idempotencyKey: string;
}

type RuntimeReceipt = GuiActionResult & {
  readonly runtimeSessionId?: string | null;
  readonly dispatchId?: string | null;
  readonly proof?: { readonly durable?: boolean; readonly canonicalVisible?: boolean };
  readonly error?: { readonly code?: string; readonly hint?: string };
  readonly code?: string;
  readonly nextAction?: string | null;
};

export interface RuntimeSpawnSettlement {
  readonly state: "applied" | "pending" | "op_rejected";
  readonly opId: string;
  readonly runtimeSessionId: string | null;
  readonly dispatchId: string | null;
  readonly code?: string;
  readonly hint: string;
}

export async function submitRuntimeSpawn(
  input: RuntimeSpawnInput,
  deps: {
    readonly spawn: (input: RuntimeSpawnInput) => Promise<unknown>;
    readonly showReceipt: (opId: string) => Promise<unknown>;
    readonly overview: () => Promise<AgentRuntimeOverviewResult>;
    readonly onPending?: (settlement: RuntimeSpawnSettlement) => void;
  },
  pause: () => Promise<void> = () => new Promise((resolve) => window.setTimeout(resolve, 250)),
): Promise<RuntimeSpawnSettlement> {
  const initial = receipt(await deps.spawn(input));
  let runtimeSessionId = initial.runtimeSessionId ?? null,
    dispatchId = initial.dispatchId ?? null;
  let current = initial;
  if (pending(current)) deps.onPending?.(pendingSettlement(current, runtimeSessionId, dispatchId));
  for (let attempt = 0; attempt < 80 && pending(current); attempt += 1) {
    await pause();
    current = receipt(await deps.showReceipt(current.opId));
    runtimeSessionId = current.runtimeSessionId ?? runtimeSessionId;
    dispatchId = current.dispatchId ?? dispatchId;
    if (pending(current)) deps.onPending?.(pendingSettlement(current, runtimeSessionId, dispatchId));
  }
  if (
    current.outcome === "applied" &&
    current.proof?.durable === true &&
    current.proof.canonicalVisible === true &&
    runtimeSessionId
  ) {
    const overview = await deps.overview();
    if (
      overview.status === "ready" &&
      overview.sessions.some((session) => session.runtimeSessionId === runtimeSessionId)
    )
      return {
        state: "applied",
        opId: current.opId,
        runtimeSessionId,
        dispatchId,
        hint: "Canonical runtime session is visible.",
      };
    return {
      state: "pending",
      opId: current.opId,
      runtimeSessionId,
      dispatchId,
      code: "projection_not_visible",
      hint: "Receipt is applied, but the runtime session is not visible in the canonical overview. Keep this opId; do not resubmit.",
    };
  }
  if (pending(current) || current.outcome === "applied")
    return {
      state: "pending",
      opId: current.opId,
      runtimeSessionId,
      dispatchId,
      code: current.code ?? current.outcome,
      hint: current.nextAction ?? "Keep this opId and poll its receipt; do not resubmit.",
    };
  return {
    state: "op_rejected",
    opId: current.opId,
    runtimeSessionId,
    dispatchId,
    code: current.error?.code ?? current.code ?? "runtime_spawn_rejected",
    hint: current.error?.hint ?? current.nextAction ?? "Runtime spawn was rejected.",
  };
}

function receipt(value: unknown): RuntimeReceipt {
  if (
    !isRendererRecord(value) ||
    value.schema !== "command-receipt/v2" ||
    typeof value.opId !== "string" ||
    !["applied", "pending", "no_changes", "indeterminate", "op_rejected"].includes(String(value.outcome))
  )
    throw new Error(rendererErrorHint(value, "Runtime spawn returned an invalid receipt."));
  return value as RuntimeReceipt;
}
function pending(value: RuntimeReceipt): boolean {
  return value.outcome === "pending" || value.outcome === "indeterminate";
}
function pendingSettlement(
  value: RuntimeReceipt,
  runtimeSessionId: string | null,
  dispatchId: string | null,
): RuntimeSpawnSettlement {
  return {
    state: "pending",
    opId: value.opId,
    runtimeSessionId,
    dispatchId,
    code: value.code ?? value.outcome,
    hint: value.nextAction ?? "Keep this opId and poll its receipt; do not resubmit.",
  };
}
