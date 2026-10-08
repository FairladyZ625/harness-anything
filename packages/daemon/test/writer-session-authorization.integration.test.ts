// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { localDefaultBinding } from "../src/daemon-host-binding.ts";
import { resolveRepoBootstrap } from "../src/repo-bootstrap.ts";
import { openWriterSupervisor } from "../src/writer-supervisor.ts";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";
import { initRepo } from "./task-surface.fixtures.ts";
import type { DaemonAuthenticationContext } from "../src/transport/auth-context.ts";

for (const scenario of ["init", "delayed-write", "ended-session"] as const) {
  test(`production writer resolves the original host session for ${scenario}`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-writer-session-")),
      repoId = workspaceId("writer-session"),
      rootDir = canonicalRoot(root),
      seen: string[] = [],
      server = createServer((request, response) => {
        seen.push(request.headers.authorization ?? "");
        response.writeHead(request.headers.authorization === "Bearer live-token" ? 200 : 401, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify({ result: true }));
      });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as import("node:net").AddressInfo,
      authority = openPersistentWriterEpoch({ stateRoot: path.join(root, "epochs"), holderId: "session-test" }),
      lease = authority.acquire(repoId),
      fence = {
        schema: "harness-writer-epoch-fence/v1" as const,
        stateRoot: path.join(root, "epochs"),
        repoId,
        epoch: lease.epoch,
        holderId: lease.holderId,
      };
    authority.close();
    let token = scenario === "init" ? "old-token" : "live-token",
      calls = 0,
      release!: () => void,
      requested!: () => void;
    const requestedToken = new Promise<void>((resolve) => {
        requested = resolve;
      }),
      releasedToken = new Promise<void>((resolve) => {
        release = resolve;
      }),
      auth: DaemonAuthenticationContext = {
        transportKind: "unix-socket",
        unixSocketOwnerBoundary: { ownerUid: 501, source: "unix-socket-filesystem-owner-boundary" },
        oidcPrincipal: {
          personId: "person-session",
          subject: "subject-session",
          expiresAt: Date.now() + 60_000,
          accessToken: token,
          authority: { url: `http://127.0.0.1:${address.port}`, realm: "harness", clientId: "harness-center" },
        },
        localSessionAccessToken: async () => {
          calls += 1;
          requested();
          await releasedToken;
          return token;
        },
      };
    let supervisor: Awaited<ReturnType<typeof openWriterSupervisor>> | undefined;
    try {
      initRepo(rootDir);
      // Init exercises workerData and the first open-time authorization, rather than a helper.
      const bootstrap = resolveRepoBootstrap(
          { rootDir, repoId, personId: "person-session", displayName: "Session" },
          auth,
        ),
        opening = openWriterSupervisor({
          repoId,
          rootDir,
          ownerId: "session-test",
          bootstrap,
          defaultWriterEpochFence: fence,
        });
      if (scenario === "init") {
        await Promise.race([
          requestedToken,
          opening.then(() => {
            throw new Error("init did not resolve the host session");
          }),
        ]);
        token = "live-token";
        release();
      } else {
        token = "live-token";
        release();
      }
      supervisor = await opening;
      assert.equal((supervisor.bootstrapReceipt() as { outcome: string }).outcome, "applied");
      if (scenario === "init") {
        assert.ok(calls > 0, "init requested a current token from the host");
        assert.ok(seen.length > 0, "init authorizes through UMA");
      } else {
        const initCalls = calls;
        // Reset the synchronization barrier so the token changes after postMessage, at authorization.
        token = "old-token";
        const delayed = new Promise<void>((resolve) => {
          release = resolve;
        });
        const binding = localDefaultBinding({
          ...auth,
          localSessionAccessToken: async () => {
            calls += 1;
            requested();
            await delayed;
            if (scenario === "ended-session")
              throw Object.assign(new Error("original session ended"), { code: "authentication_required" });
            return token;
          },
        });
        const reached = new Promise<void>((resolve) => {
            requested = resolve;
          }),
          result = supervisor.request<{ outcome: string; code?: string }>(
            "run",
            { action: { kind: "task-create", taskId: "task-session", title: "Session" } },
            binding,
          );
        const umaBefore = seen.length;
        // Attach a rejection handler before waiting: DataCloneError is the pre-fix positive control.
        await Promise.race([
          reached,
          result.then(() => {
            throw new Error("write did not resolve the host session");
          }),
        ]);
        token = "live-token";
        release();
        if (scenario === "ended-session") {
          const denied = await result;
          assert.equal(denied.outcome, "op_rejected");
          assert.equal(denied.code, "authentication_required");
          assert.equal(seen.length, umaBefore, "ended sessions never send UMA");
        } else {
          assert.equal((await result).outcome, "applied");
          assert.equal(seen.length, umaBefore + 1, "one UMA call without retry");
        }
        assert.equal(calls, initCalls + 1);
      }
      assert.ok(seen.every((authorization) => authorization === "Bearer live-token"));
    } finally {
      release();
      await supervisor?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      rmSync(root, { recursive: true, force: true });
    }
  });
}
