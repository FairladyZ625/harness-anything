// harness-test-tier: fast
// dec_42EB7B8F636C12381A447E52A3/CH2: headless CLI contract tests for `ha fde`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runFdeLaunch } from "../src/cli/fde-launch.ts";
import { cliCapabilities, clientLocalCommands, declaredCommandDomains } from "../src/cli/thin-command-help.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

function makeBuiltFdeFixture(t: test.TestContext): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ha-fde-cli-"));
  t.after(() => removeTempRepository(dir));
  mkdirSync(path.join(dir, "dist"), { recursive: true });
  mkdirSync(path.join(dir, "dist-electron"), { recursive: true });
  writeFileSync(path.join(dir, "dist/index.html"), "<html></html>", "utf8");
  writeFileSync(path.join(dir, "dist-electron/electron-preload.cjs"), "", "utf8");
  writeFileSync(path.join(dir, "dist-electron/electron-main.js"), "", "utf8");
  return dir;
}

test("registers fde in CLI capabilities and client-local command directory", () => {
  assert.ok(declaredCommandDomains.includes("fde"));
  assert.deepEqual(cliCapabilities.fde, ["fde"]);
  const fdeCmd = clientLocalCommands.find((cmd) => cmd.id === "fde");
  assert.ok(fdeCmd);
  assert.match(fdeCmd.usage, /^ha fde /u);
});

test("rejects missing gui-fde package and invalid flags cleanly", async () => {
  const receipts: Record<string, unknown>[] = [];
  const emit = (receipt: Record<string, unknown>) => receipts.push(receipt);

  const missingCode = await runFdeLaunch(["fde", "--json"], { resolveFdePackageRoot: () => undefined }, emit);
  assert.equal(missingCode, 1);
  assert.equal(receipts.at(-1)?.code, "fde_unavailable");

  const portWithoutBrowser = await runFdeLaunch(["fde", "--port", "4000", "--json"], {}, emit);
  assert.equal(portWithoutBrowser, 2);
  assert.equal(receipts.at(-1)?.code, "invalid_field");

  const unknownFlag = await runFdeLaunch(["fde", "--bogus", "--json"], {}, emit);
  assert.equal(unknownFlag, 2);
  assert.equal(receipts.at(-1)?.code, "unsupported_command");
});

test("starts browser studio mode headlessly and emits a loopback URL receipt", async (t) => {
  const fdePackageRoot = makeBuiltFdeFixture(t);
  const receipts: Record<string, unknown>[] = [];
  let closed = false;
  let capturedPort: number | undefined;

  const code = await runFdeLaunch(
    ["fde", "--browser", "--port", "4123", "--root", fdePackageRoot, "--json"],
    {
      fdePackageRoot,
      startBrowserServer: async ({ port }) => {
        capturedPort = port;
        return {
          url: "http://127.0.0.1:4123/#access_token=test-token",
          close: async () => {
            closed = true;
          },
        };
      },
      waitForBrowserClose: async (server) => {
        await server.close();
      },
    },
    (receipt) => receipts.push(receipt),
  );

  assert.equal(code, 0);
  assert.equal(capturedPort, 4123);
  assert.equal(closed, true);
  assert.equal(receipts[0]?.ok, true);
  assert.equal(receipts[0]?.mode, "browser");
  assert.equal(receipts[0]?.url, "http://127.0.0.1:4123/#access_token=test-token");
});

test("launches desktop Electron mode headlessly via readiness handshake without spawning real windows", async (t) => {
  const fdePackageRoot = makeBuiltFdeFixture(t);
  const receipts: Record<string, unknown>[] = [];

  const code = await runFdeLaunch(
    ["fde", "--root", fdePackageRoot, "--json"],
    {
      fdePackageRoot,
      resolveElectronRuntime: () => ({ binary: "/mock/electron", remedy: "" }),
      startDetached: (() => ({ pid: 4242, on: () => undefined, once: () => undefined })) as never,
      waitForReady: async () => ({ ok: true, mode: "headless", pid: 4242 }),
    },
    (receipt) => receipts.push(receipt),
  );

  assert.equal(code, 0);
  assert.equal(receipts[0]?.ok, true);
  assert.equal(receipts[0]?.pid, 4242);
  assert.equal(receipts[0]?.mode, "headless");
});
