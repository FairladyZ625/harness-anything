// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AuthorityFenceUnavailableError,
  acquireSingleHostAuthorityFence
} from "../src/index.ts";

test("one thousand concurrent two-instance fence races never admit two authorities", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ha-fence-race-"));
  const endpoint = { host: "127.0.0.1", port: await reserveLoopbackPort() } as const;
  const enrollmentPath = path.join(root, "authority.fence");
  try {
    for (let round = 0; round < 1_000; round += 1) {
      const attempts = await Promise.allSettled([
        acquireSingleHostAuthorityFence({ enrollmentPath, endpoint, instanceId: `a-${round}` }),
        acquireSingleHostAuthorityFence({ enrollmentPath, endpoint, instanceId: `b-${round}` })
      ]);
      const winners = attempts.filter((attempt) => attempt.status === "fulfilled");
      const losers = attempts.filter((attempt) => attempt.status === "rejected");

      assert.equal(winners.length, 1, `round ${round} admitted ${winners.length} authorities`);
      assert.equal(losers.length, 1, `round ${round} rejected ${losers.length} authorities`);
      assert.equal(
        losers.every((attempt) => attempt.status === "rejected" && attempt.reason instanceof AuthorityFenceUnavailableError),
        true
      );
      if (winners[0]?.status === "fulfilled") {
        await winners[0].value.assertHeld();
        await winners[0].value.release();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unlink and recreate invalidates the exact file identity without admitting a competing authority", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ha-fence-unlink-"));
  const endpoint = { host: "127.0.0.1", port: await reserveLoopbackPort() } as const;
  const enrollmentPath = path.join(root, "authority.fence");
  const original = await acquireSingleHostAuthorityFence({ enrollmentPath, endpoint, instanceId: "original" });
  try {
    await original.assertHeld();
    await unlink(enrollmentPath);
    await writeFile(enrollmentPath, "recreated attacker-controlled path\n", { mode: 0o600 });

    await assert.rejects(
      acquireSingleHostAuthorityFence({ enrollmentPath, endpoint, instanceId: "competitor" }),
      AuthorityFenceUnavailableError
    );
    await assert.rejects(original.assertHeld(), { code: "AUTHORITY_FENCE_LOST" });
    await assert.rejects(original.assertHeld(), { code: "AUTHORITY_FENCE_LOST" });

    await assert.rejects(
      acquireSingleHostAuthorityFence({ enrollmentPath, endpoint, instanceId: "automatic-takeover" }),
      AuthorityFenceUnavailableError
    );
    await rm(enrollmentPath, { force: true });
    const restarted = await acquireSingleHostAuthorityFence({ enrollmentPath, endpoint, instanceId: "manual-restart" });
    await restarted.assertHeld();
    await restarted.release();
  } finally {
    await original.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("a differently configured endpoint cannot replace a live valid enrollment", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ha-fence-misconfig-"));
  const firstEndpoint = { host: "127.0.0.1", port: await reserveLoopbackPort() } as const;
  let secondPort = await reserveLoopbackPort();
  while (secondPort === firstEndpoint.port) secondPort = await reserveLoopbackPort();
  const secondEndpoint = { host: "127.0.0.1", port: secondPort } as const;
  const enrollmentPath = path.join(root, "authority.fence");
  const original = await acquireSingleHostAuthorityFence({ enrollmentPath, endpoint: firstEndpoint, instanceId: "original" });
  try {
    await assert.rejects(
      acquireSingleHostAuthorityFence({ enrollmentPath, endpoint: secondEndpoint, instanceId: "misconfigured" }),
      AuthorityFenceUnavailableError
    );
    await original.assertHeld();
  } finally {
    await original.release();
    await rm(root, { recursive: true, force: true });
  }
});

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const port = typeof address === "object" ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
