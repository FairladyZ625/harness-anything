import { Effect } from "effect";
import {
  makeEnvironmentCurrentSessionProbe,
  makeRuntimeEventLedgerService,
  runtimeEventActorFromTaskHolderPrincipal
} from "../../../application/src/index.ts";
import { makeOperationalJournaledWriteCoordinator } from "../../../kernel/src/index.ts";
import type { CommandFailureReceipt } from "./receipt.ts";
import { stripGlobalOptions } from "./parse-options.ts";
import { resolveCliTaskHolderPrincipal, resolveLocalCliActorAttribution } from "../composition/local-principal.ts";

export async function appendParseFailureRuntimeEvent(
  argv: ReadonlyArray<string>,
  error: CommandFailureReceipt["error"]
): Promise<void> {
  const stripped = stripGlobalOptions(argv);
  const layoutOverrides = stripped.authoredRoot ? { authoredRoot: stripped.authoredRoot } : undefined;
  const rootInput = layoutOverrides ? { rootDir: stripped.rootDir, layoutOverrides } : stripped.rootDir;
  const session = await Effect.runPromise(makeEnvironmentCurrentSessionProbe().currentSession);
  const attribution = resolveLocalCliActorAttribution(rootInput, process.env, stripped.actor);
  const actor = runtimeEventActorFromTaskHolderPrincipal(resolveCliTaskHolderPrincipal(rootInput, attribution));
  const service = makeRuntimeEventLedgerService({
    rootInput,
    coordinator: makeOperationalJournaledWriteCoordinator({
      rootDir: stripped.rootDir,
      ...(layoutOverrides ? { layoutOverrides } : {}),
      operationalActor: { scope: "operational", kind: "agent", id: "runtime-event-cli" }
    })
  });
  await Effect.runPromise(service.append({
    kind: "result",
    actor,
    session: {
      sessionId: session.sessionId,
      runtime: session.runtime
    },
    tool: {
      toolName: "parse",
      ...(error?.code ? { errorCode: error.code } : {})
    },
    result: {
      status: "failed",
      summary: "CLI parse failed",
      ...(error?.code ? { errorCode: error.code } : {})
    }
  })).catch(() => {
    // Parse errors must remain honest even when telemetry is unavailable.
  });
}
