// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FIRST_RUN_BOOTSTRAP_CHANNEL, FIRST_RUN_CHOOSE_CHANNEL } from "../src/api/first-run-contract.ts";
import { daemonServeLaunch } from "../src/main/daemon-serve-launch.ts";
import { registerFirstRunIpcHandlers, validateFirstRunBootstrapInput } from "../src/main/first-run-ipc.ts";

const trustedEvent = {
  sender: { id: 7 },
  senderFrame: { url: "file:///Applications/Harness/renderer/index.html" },
};
const trustPolicy = {
  isTrustedWebContentsId: (id: number) => id === 7,
  rendererUrl: { packagedRendererUrl: trustedEvent.senderFrame.url },
};

test("first-run IPC stays closed and forwards a validated bootstrap", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-first-run-ipc-"));
  const handlers = new Map<string, (event: typeof trustedEvent, payload: unknown) => Promise<unknown>>();
  const received: unknown[] = [];
  try {
    registerFirstRunIpcHandlers(
      {
        handle: (channel, listener) => {
          handlers.set(channel, listener as never);
        },
      },
      {
        chooseRepository: async () => rootDir,
        bootstrap: async (input) => {
          received.push(input);
          return { ok: true, repoId: input.repoId };
        },
      },
      trustPolicy,
    );
    assert.deepEqual([...handlers.keys()], [FIRST_RUN_CHOOSE_CHANNEL, FIRST_RUN_BOOTSTRAP_CHANNEL]);
    assert.equal(await handlers.get(FIRST_RUN_CHOOSE_CHANNEL)?.(trustedEvent, null), rootDir);
    const input = {
      rootDir,
      repoId: "first-repo",
      personId: "person_owner",
      displayName: "First Owner",
      name: "First Repo",
      addNpmScripts: true,
    };
    assert.deepEqual(await handlers.get(FIRST_RUN_BOOTSTRAP_CHANNEL)?.(trustedEvent, input), {
      ok: true,
      repoId: "first-repo",
    });
    assert.deepEqual(received, [input]);
    await assert.rejects(
      () =>
        handlers.get(FIRST_RUN_BOOTSTRAP_CHANNEL)?.({ ...trustedEvent, sender: { id: 8 } }, input) ?? Promise.resolve(),
      /untrusted_web_contents/u,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("first-run bootstrap rejects paths and identity fields outside its contract", () => {
  assert.throws(
    () =>
      validateFirstRunBootstrapInput({
        rootDir: "relative/repo",
        repoId: "Bad Repo",
        personId: "7owner",
        displayName: "Owner\nSecond line",
      }),
    /absolute/u,
  );
  assert.throws(
    () =>
      validateFirstRunBootstrapInput({
        rootDir: path.resolve(tmpdir(), "missing-first-run-repo"),
        repoId: "repo",
        personId: "owner",
        displayName: "Owner",
      }),
    /does not exist/u,
  );
});

test("packaged daemon launch uses the CLI package's declared dist layout", () => {
  const resourcesPath = path.join(path.sep, "Applications", "Harness Anything.app", "Contents", "Resources");
  const launch = daemonServeLaunch({ userRoot: "/Users/owner/.harness", daemonId: "default" }, { resourcesPath });
  assert.equal(launch.args[0], path.join(resourcesPath, "app", "packages", "cli", "dist", "cli", "src", "index.js"));
  assert.deepEqual(launch.args.slice(1), [
    "daemon",
    "serve",
    "--user-root",
    "/Users/owner/.harness",
    "--daemon-id",
    "default",
  ]);
});
