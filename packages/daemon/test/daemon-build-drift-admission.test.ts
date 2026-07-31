// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryTerminalSessionService } from "../src/terminal/session-registry.ts";
import {
  commandRunRequest,
  emptyLocalController,
  makeServer,
  readFixture,
  resultReceipt,
  rosterIdentityOptions,
  sampleRoster
} from "./json-rpc-protocol-fixtures.ts";

test("artifact drift rejects writes before mixed-version service dispatch and keeps reads available", async () => {
  const loadedIdentity = `sha256:${"a".repeat(64)}`;
  const installedIdentity = `sha256:${"b".repeat(64)}`;
  const dispatched: string[] = [];
  const roster = sampleRoster();
  const server = makeServer({
    ...rosterIdentityOptions(roster),
    authContext: {
      transportKind: "ssh-exec",
      sshExecUser: { username: "alice", host: "team-host", source: "ssh-authenticated-exec" }
    },
    readBuildIdentity: () => ({ loadedIdentity, installedIdentity }),
    services: {
      LocalControllerService: emptyLocalController(),
      TerminalSessionService: createInMemoryTerminalSessionService({ createId: () => "term-1" }),
      CliCommandService: {
        runCommand: async (payload) => {
          const command = payload?.command as { readonly action?: { readonly kind?: string } } | undefined;
          dispatched.push(command?.action?.kind ?? "unknown");
          return {
            ok: true,
            schema: "command-receipt/v2",
            command: command?.action?.kind ?? "unknown",
            action: "run",
            summary: "dispatched",
            details: {},
            meta: {
              generatedAt: "2026-07-31T00:00:00.000Z",
              compatibility: {}
            }
          };
        }
      }
    }
  });
  await server.handle(readFixture("hello-compatible.json"));

  const write = resultReceipt(await server.handle(commandRunRequest("task-complete", "write-stale")));
  assert.equal(write.ok, false);
  assert.equal(write.error?.code, "daemon_build_stale");
  assert.match(write.error?.hint ?? "", new RegExp(loadedIdentity, "u"));
  assert.match(write.error?.hint ?? "", new RegExp(installedIdentity, "u"));
  assert.match(write.error?.hint ?? "", /ha daemon start --service/u);
  assert.deepEqual(write.details.data, {
    loadedIdentity,
    installedIdentity,
    nextCommand: "ha daemon start --service"
  });
  assert.deepEqual(write.next, [{
    command: "ha daemon start --service",
    description: "Restart the daemon on the current dist build, then retry the original write."
  }]);
  assert.deepEqual(dispatched, []);

  const read = resultReceipt(await server.handle(commandRunRequest("task-show", "read-stale")));
  assert.equal(read.ok, true);
  assert.deepEqual(dispatched, ["task-show"]);
});
