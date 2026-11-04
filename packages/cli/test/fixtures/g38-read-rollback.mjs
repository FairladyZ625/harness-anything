import { runAgentRollback } from "../../src/cli-agent-rollback.ts";

// Exercise the CLI's real read composition without adding an export to the product package.
export function readRollback({ runtime, projection, rootDir }) {
  return runAgentRollback(
    { agentId: "g38-agent", toRevision: projection.getEntity("agent", "g38-agent").workspaceRevision, json: true },
    async ({ action }) => ({ ...(await runtime.run(action, runtime.binding)), ok: true }),
    { rootDir, repoId: "g38-read" },
  );
}
