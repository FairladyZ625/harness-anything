// harness-test-tier: fast
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { daemonHostStartRefusal } from "../src/client/daemon-autostart.ts";
import { startDaemon } from "../src/runtime.ts";
import {
  checkWorkspaceLinks,
  firstWorkspaceLinkFinding,
  workspaceLinkDoctorCheck,
} from "../src/workspace-link-integrity.ts";

function workspaceFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "ha-workspace-links-"));
  mkdirSync(path.join(root, "packages", "cli"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
  writeFileSync(path.join(root, "packages", "cli", "package.json"), JSON.stringify({ name: "@harness-anything/cli" }));
  mkdirSync(path.join(root, "node_modules", "@harness-anything"), { recursive: true });
  return root;
}

test("workspace links that stay in the checkout pass the integrity check", (t) => {
  if (process.platform === "win32") t.skip("requires POSIX file-symbolic-link semantics");
  const root = workspaceFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  symlinkSync("../../packages/cli", path.join(root, "node_modules", "@harness-anything", "cli"));
  assert.deepEqual(checkWorkspaceLinks(root), { rootDir: root, checked: 1, findings: [], ok: true });
  assert.equal(firstWorkspaceLinkFinding([root]), null);
  assert.equal(workspaceLinkDoctorCheck(root).status, "ok");
});

test("an external workspace link is named with its repair command", (t) => {
  if (process.platform === "win32") t.skip("requires POSIX file-symbolic-link semantics");
  const root = workspaceFixture(),
    external = mkdtempSync(path.join(tmpdir(), "ha-external-workspace-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  });
  symlinkSync(external, path.join(root, "node_modules", "@harness-anything", "cli"));
  const check = checkWorkspaceLinks(root),
    finding = check.findings[0]!;
  assert.equal(check.ok, false);
  assert.equal(check.checked, 1);
  assert.equal(finding.packageName, "@harness-anything/cli");
  assert.equal(finding.target, external);
  assert.match(finding.repairCommand, /ln -sfn \.\.\/\.\.\/packages\/cli .*node_modules/u);
  assert.equal(firstWorkspaceLinkFinding([root])?.linkPath, finding.linkPath);
  assert.deepEqual(workspaceLinkDoctorCheck(root), {
    id: "workspace-links",
    status: "fail",
    count: 1,
    summary: `@harness-anything/cli: ${finding.linkPath} -> ${external}`,
    next: `Repair the workspace link with \`${finding.repairCommand}\`, then restart the daemon.`,
  });
});

test("an external scope parent cannot hide a workspace link", (t) => {
  if (process.platform === "win32") t.skip("requires POSIX file-symbolic-link semantics");
  const root = workspaceFixture(),
    externalScope = mkdtempSync(path.join(tmpdir(), "ha-external-workspace-scope-")),
    scopePath = path.join(root, "node_modules", "@harness-anything");
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(externalScope, { recursive: true, force: true });
  });
  rmSync(scopePath, { recursive: true, force: true });
  symlinkSync(externalScope, scopePath, "dir");
  symlinkSync("../../packages/cli", path.join(externalScope, "cli"));

  const check = checkWorkspaceLinks(root),
    finding = check.findings[0]!;
  assert.equal(check.ok, false);
  assert.equal(finding.physicalParent, externalScope);
  assert.equal(finding.target, path.resolve(externalScope, "../../packages/cli"));
  assert.match(finding.repairCommand, /ln -sfn .*packages\/cli .*node_modules/u);
  const doctor = workspaceLinkDoctorCheck(root);
  assert.equal(doctor.status, "fail");
  assert.match(doctor.next, /ln -sfn .*packages\/cli/u);
});

test("daemon startup refuses external workspace links before creating its pid", async (t) => {
  if (process.platform === "win32") t.skip("requires POSIX file-symbolic-link semantics");
  const root = workspaceFixture(),
    external = mkdtempSync(path.join(tmpdir(), "ha-external-daemon-workspace-")),
    userRoot = path.join(root, ".daemon-user");
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  });
  const scopePath = path.join(root, "node_modules", "@harness-anything");
  rmSync(scopePath, { recursive: true, force: true });
  symlinkSync(external, scopePath, "dir");
  symlinkSync("../../packages/cli", path.join(external, "cli"));
  mkdirSync(userRoot, { recursive: true });
  writeFileSync(
    path.join(userRoot, "registry.json"),
    JSON.stringify({
      schema: "harness-daemon-registry/v2",
      connections: [{ id: "local", kind: "local", displayName: "Local", state: "enabled" }],
      repos: [
        {
          repoId: "workspace-links",
          canonicalRoot: root,
          displayName: "workspace-links",
          authoredBranch: "main",
          mode: "local",
          connectionId: "local",
          state: "enabled",
          registeredAt: "2026-11-09T00:00:00.000Z",
        },
      ],
    }),
  );
  const refusal = await daemonHostStartRefusal({ invokingRoot: root, userRoot });
  assert.equal(refusal?.code, "daemon_start_workspace_links_external");
  assert.match(refusal?.hint ?? "", /ln -sfn .*packages\/cli/u);
  await assert.rejects(
    () => startDaemon({ userRoot, daemonId: "workspace-links", endpoint: path.join(userRoot, "daemon.sock") }),
    (error: unknown) => {
      assert.equal((error as { readonly code?: string }).code, "daemon_start_workspace_links_external");
      assert.match(String((error as Error).message), /ln -sfn .*packages\/cli/u);
      return true;
    },
  );
  assert.equal(existsSync(path.join(userRoot, "workspace-links.pid")), false);
});
