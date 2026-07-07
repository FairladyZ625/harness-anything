import { Effect } from "effect";
import { makeEnvironmentCurrentSessionProbe, makeRuntimeEventLedgerService } from "../../../application/src/index.ts";
import type { CommandFailureReceipt } from "./receipt.ts";
import { stripGlobalOptions } from "./parse-options.ts";

export async function appendParseFailureRuntimeEvent(
  argv: ReadonlyArray<string>,
  error: CommandFailureReceipt["error"]
): Promise<void> {
  const stripped = stripGlobalOptions(argv);
  const layoutOverrides = stripped.authoredRoot ? { authoredRoot: stripped.authoredRoot } : undefined;
  const rootInput = layoutOverrides ? { rootDir: stripped.rootDir, layoutOverrides } : stripped.rootDir;
  const session = await Effect.runPromise(makeEnvironmentCurrentSessionProbe().currentSession);
  const service = makeRuntimeEventLedgerService({ rootInput });
  await Effect.runPromise(service.append({
    kind: "result",
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
