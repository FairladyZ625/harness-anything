// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareFixtureIdentity } from "./measure-cli-command-timing.mjs";

// The nightly fixture's first `ha init` failed with rbac_not_configured until this bootstrap ran.
// The measured CLI is replaced by a receipt stub so the test can name the exact sequence the
// fixture drives: reject a bad external secret, install the authority, claim the first
// administrator once, then sign in. Any skipped step is the failure the lane hit.
test("timing fixture installs identity through the CLI bootstrap before init", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "ha-cli-timing-identity-")),
    userRoot = path.join(repo, "user"),
    calls = [],
    receipt = (body) => ({ stdout: `${JSON.stringify(body)}\n`, stderr: "", status: body.ok ? 0 : 1 });
  let administrators = 0;
  const run = (fixture, argv, options) => {
    calls.push({ repo: fixture.repo, argv, timing: options.timing, input: options.input });
    if (argv.includes("bootstrap-admin")) {
      administrators += 1;
      return receipt(administrators === 1 ? { ok: true } : { ok: false, code: "bootstrap_admin_closed" });
    }
    if (argv.includes("login")) return receipt({ ok: true });
    if (argv.includes("external"))
      return receipt(
        options.input === "invalid-candidate"
          ? { ok: false, code: "rbac_external_credentials_rejected" }
          : { ok: true },
      );
    throw new Error(`unexpected fixture command: ${argv.join(" ")}`);
  };
  let identity;
  try {
    identity = await prepareFixtureIdentity({ repo, userRoot }, run);
    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls.map(({ argv }) => argv.slice(1, 4)),
      [
        ["bootstrap", "--operation", "bootstrap-admin"],
        ["bootstrap", "--operation", "bootstrap-admin"],
        ["bootstrap", "--operation", "login"],
      ],
    );
    assert.equal(
      calls.every(({ repo: root }) => root === repo),
      true,
    );
    assert.equal(
      calls.every(({ timing }) => timing === false),
      true,
    );
    assert.equal(
      calls.every(({ input }) => input === undefined),
      true,
    );
  } finally {
    await identity?.close();
    rmSync(repo, { recursive: true, force: true, maxRetries: 5 });
  }
});
