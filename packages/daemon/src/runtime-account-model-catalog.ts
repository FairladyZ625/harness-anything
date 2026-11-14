import { runtimeInstanceError } from "./agent-runtime-instance-config.ts";
import { runExecutable } from "./agent-runtime-installation-discovery.ts";
import type { RuntimeInstanceKind } from "./agent-runtime-instance-types.ts";
import { JsonRpcLineClient } from "./client/local-json-rpc-client.ts";
import { runtimeKindForId } from "./runtime-inventory.ts";
import type { RuntimeAccountModelCatalog } from "./runtime-instance-account-probe.ts";
import { runAcpProviderSession } from "./runtime-worker-acp.ts";

// These are provider session catalogs, after a separate successful auth probe.
// Installation help and bundled model metadata never enter availableModels.
export async function probeSessionModelCatalog(
  platform: NodeJS.Platform,
  input: {
    readonly kindId: RuntimeInstanceKind;
    readonly executablePath: string;
    readonly env: NodeJS.ProcessEnv;
  },
  kind: "claude-sdk" | "codex-app-server" | "acp",
  signal: AbortSignal,
  timeoutMs: number,
): Promise<RuntimeAccountModelCatalog | null> {
  const cwd = input.env.HOME ?? input.env.USERPROFILE,
    options = { env: input.env, cwd, signal, timeoutMs, captureOutput: true };
  if (kind === "claude-sdk") {
    const output = await runExecutable(
      platform,
      input.executablePath,
      ["--print", "--output-format", "stream-json", "--verbose", "--input-format", "stream-json"],
      {
        ...options,
        input: `${JSON.stringify({ type: "control_request", request_id: "models", request: { subtype: "initialize" } })}\n`,
      },
    );
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      const frame = object(JSON.parse(line));
      if (frame.type !== "control_response") continue;
      const response = object(frame.response);
      if (response.request_id !== "models") continue;
      if (response.subtype !== "success") throw invalidCatalog();
      const data = object(response.response);
      return catalog(rows(data.models).map((row) => row.value));
    }
    throw invalidCatalog();
  }
  let result: RuntimeAccountModelCatalog | null = null;
  let acpSession: ReturnType<typeof runAcpProviderSession> | undefined;
  await runExecutable(
    platform,
    input.executablePath,
    kind === "codex-app-server" ? ["app-server"] : runtimeKindForId(input.kindId).launch.argumentTemplate,
    {
      ...options,
      input: async (child) => {
        if (kind === "acp") {
          acpSession = runAcpProviderSession(
            child,
            {
              kindId: input.kindId,
              cwd: cwd!,
              env: input.env,
              prompt: "",
              authMode: "subscription",
              handshakeTimeoutMs: timeoutMs,
            },
            (frame) => {
              const event = object(frame.event);
              if (event.type === "acp.session") result = catalog(event.models, event.currentModelId);
            },
            { catalogOnly: true },
          );
          await acpSession.done;
          const failure = acpCatalogFailure(acpSession);
          if (failure) throw failure;
          return;
        }
        const rpc = new JsonRpcLineClient(child.stdout!, child.stdin!);
        try {
          await rpc.request("initialize", { clientInfo: { name: "harness-anything", version: "0.1.0" } }, timeoutMs);
          child.stdin!.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
          const models: unknown[] = [],
            cursors = new Set<string>();
          let cursor: string | null = null,
            defaultModel: unknown;
          do {
            const page = await rpc.request("model/list", { includeHidden: false, cursor }, timeoutMs);
            for (const row of rows(page.data)) {
              if (row.hidden === true) continue;
              models.push(row.model);
              if (row.isDefault === true) defaultModel = row.model;
            }
            cursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
            // A provider repeating its cursor cannot make progress; only null ends the reader.
            if (cursor !== null && cursors.has(cursor)) throw invalidCatalog();
            if (cursor !== null) cursors.add(cursor);
          } while (cursor !== null);
          result = catalog(models, defaultModel);
        } finally {
          rpc.close();
        }
      },
    },
  ).then(undefined, (error: unknown) => {
    // Termination can close the process before its async handshake reports failure.
    // The live checkpoint still distinguishes an unfinished auth stage from model I/O.
    const failure = acpSession
      ? acpCatalogFailure(acpSession)
      : kind === "acp"
        ? runtimeInstanceError("runtime_auth_probe_failed", "ACP authentication could not start. Retry the probe.")
        : null;
    throw failure ?? error;
  });
  return result;
}

function acpCatalogFailure(session: ReturnType<typeof runAcpProviderSession>): Error | null {
  if (session.failure?.code === -32000)
    return runtimeInstanceError(
      "runtime_subscription_required",
      "ACP requires subscription sign-in for this instance.",
    );
  if (!session.authenticationComplete)
    return runtimeInstanceError(
      "runtime_auth_probe_failed",
      "ACP authentication could not determine readiness. Retry the probe.",
    );
  return session.failure ? invalidCatalog() : null;
}

function catalog(values: unknown, preferred?: unknown): RuntimeAccountModelCatalog | null {
  const models = [
    ...new Set(
      (Array.isArray(values) ? values : []).filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      ),
    ),
  ];
  return models.length
    ? { models, defaultModel: typeof preferred === "string" && models.includes(preferred) ? preferred : models[0]! }
    : null;
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw invalidCatalog();
  return value.map(object);
}
function invalidCatalog(): Error {
  return runtimeInstanceError("runtime_model_catalog_invalid", "The provider did not return an account model catalog.");
}
