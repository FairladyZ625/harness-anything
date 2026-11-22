// harness-test-tier: integration
// dec_42EB7B8F636C12381A447E52A3/CH2: loopback HTTP server security, API compilation/simulation/persistence contract.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultFdeDraft, startFdeStudioServer } from "../src/index.ts";

test("serves authenticated loopback studio APIs with strict CSP and runs live V4 simulation", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-gui-fde-srv-"));
  const distDir = path.join(rootDir, "dist-static");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(path.join(distDir, "index.html"), "<!doctype html><html><body>fde-ok</body></html>", "utf8");
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const server = await startFdeStudioServer({
    rootDir,
    distDir,
    queryDaemonVerticals: async () => ({
      connected: true,
      verticals: [{ id: "office/collab", title: "Office Collab" }],
    }),
  });
  t.after(() => server.close());

  // Static page renders with strict security headers.
  const indexRes = await fetch(`${server.origin}/`);
  assert.equal(indexRes.status, 200);
  assert.match(indexRes.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/u);
  assert.equal(indexRes.headers.get("x-content-type-options"), "nosniff");
  assert.equal(indexRes.headers.get("referrer-policy"), "no-referrer");
  assert.match(await indexRes.text(), /fde-ok/u);

  // Unauthenticated API requests are rejected fail-closed.
  const unauth = await fetch(`${server.origin}/api/bootstrap`);
  assert.equal(unauth.status, 403);

  const authHeaders = {
    Authorization: `Bearer ${server.token}`,
    "Content-Type": "application/json",
    Origin: server.origin,
  };

  const bootRes = await fetch(`${server.origin}/api/bootstrap`, { headers: authHeaders });
  assert.equal(bootRes.status, 200);
  const boot = (await bootRes.json()) as {
    readonly daemonConnected: boolean;
    readonly installedVerticals: readonly { readonly id: string }[];
  };
  assert.equal(boot.daemonConnected, true);
  assert.equal(boot.installedVerticals[0]?.id, "office/collab");

  const draft = createDefaultFdeDraft({ verticalId: "ops/incident-review", title: "Incident Review" });
  const simRes = await fetch(`${server.origin}/api/simulate`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ draft, locale: "en-US" }),
  });
  assert.equal(simRes.status, 200);
  const sim = (await simRes.json()) as {
    readonly compiled: {
      readonly files: readonly unknown[];
      readonly htmlPreviews: { readonly projectAtlasHtml: string };
    };
    readonly report: { readonly ok: boolean; readonly gates: readonly { readonly ok: boolean }[] };
  };
  assert.equal(sim.report.ok, true);
  assert.equal(sim.report.gates[0]?.ok, true);
  assert.ok(sim.compiled.files.length > 10);
  assert.match(sim.compiled.htmlPreviews.projectAtlasHtml, /ops\/incident-review/u);

  const persistRes = await fetch(`${server.origin}/api/persist`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ draft, overwrite: false, dryRun: false }),
  });
  assert.equal(persistRes.status, 200);
  assert.equal(existsSync(path.join(rootDir, "verticals/ops-incident-review/vertical.json")), true);
});
