import type { RepoCellBinding } from "./repo-cell-types.ts";
import { makeRepoReadRuntime } from "./repo-read-runtime.ts";
import { withBorrowedReplicaGeneration } from "./fleet/replica-generation.ts";
import type { RepoReadPayload, RepoWriterRequestV1 } from "./repo-writer-protocol.ts";

let runtime: ReturnType<typeof makeRepoReadRuntime> | null = null;
let configKey: string | null = null;
let frame: RepoReadPayload;

/** Executed by the existing worker request handler, with its shared receipt/error boundary. */
export async function executeRepoReadRequest(request: RepoWriterRequestV1): Promise<unknown> {
  frame = request.payload as RepoReadPayload;
  const key = JSON.stringify(frame.config);
  if (key !== configKey) {
    await runtime?.close();
    runtime = makeRepoReadRuntime({
      ...frame.config,
      now: () => frame.now ?? new Date().toISOString(),
      runtimeInstances: () => frame.runtimeInstances ?? [],
      edgeConfig: () => frame.edge?.config ?? null,
    });
    configKey = key;
  }
  return withBorrowedReplicaGeneration(frame.edge?.pin, () => executeRead(request));
}

function executeRead(request: RepoWriterRequestV1): unknown {
  const reader = runtime!,
    args = frame.args;
  // Live policy resolution stays on the host's asynchronous authority port. Query sessions
  // receive its completed decisions, never a provider object or refresh callback.
  const binding: RepoCellBinding | undefined = request.binding
    ? { ...request.binding, keycloakAuthorization: undefined }
    : undefined;
  let value: unknown;
  switch (frame.method) {
    case "read":
      value = reader.read(args[0] as never, args[1] as never, binding, args[2] as number | undefined);
      break;
    case "run":
      value = reader.run(args[0] as never, binding!);
      break;
    case "explainBasis":
      value = reader.explainBasis(args[0] as never, binding);
      break;
    case "readNodeAutoClaimAssignments":
      value = reader.readNodeAutoClaimAssignments(binding);
      break;
    case "readNodeAutoDispatchCandidates":
      value = reader.readNodeAutoDispatchCandidates(String(args[0]));
      break;
    case "observeTail":
      value = reader.observeTail(args[0] as never, args[1] as never, binding);
      break;
    case "readSession":
      value = reader.readSession(String(args[0]));
      break;
    case "readSettlementSession":
      value = reader.readSettlementSession(String(args[0]));
      break;
    case "canAttach":
      value = reader.canAttach(args[0] as never);
      break;
    case "readDispatchLifecycle":
      value = reader.readDispatchLifecycle(args[0] as import("@harness-anything/kernel").DispatchLifecycleQuery);
      break;
    case "readEventWitness":
      value = reader.readEventWitness(Number(args[0]));
      break;
    case "inFlightWork":
      value = reader.inFlightWork(Number(args[0]));
      break;
    case "scheduleOccurrenceSettlementOwner":
      value = reader.scheduleOccurrenceSettlementOwner(args[0] as string | undefined);
      break;
    default:
      throw new Error(`Unknown repository read operation ${frame.method}.`);
  }
  return value;
}
