// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { removeTemporaryDirectory } from "../../../tools/temporary-directory-cleanup.mjs";
import {
  annotateHostingCredentialNotice,
  hostedCredentialDoctorCheck,
  hostingCredentialDispatchNotice,
} from "../src/hosting-credential-readiness.ts";
import { hostingCredentialConfigurationAdvice } from "../src/hosting-provider.ts";
import { validateRuntimeSpawnReceipt } from "../src/gui-s3-control.ts";

const githubInstance = {
  instanceId: "instance-github",
  enabled: true,
  hostingCredentialRefs: { github: "credential:v1:github" },
};
const gitlabInstance = {
  instanceId: "instance-gitlab",
  enabled: true,
  hostingCredentialRefs: { gitlab: "credential:v1:gitlab" },
};

function repoWithOrigin(remote: string): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-hosting-credential-"));
  execFileSync("git", ["-C", rootDir, "init", "--quiet"]);
  execFileSync("git", ["-C", rootDir, "remote", "add", "origin", remote]);
  return rootDir;
}

test("doctor check reports ok when an enabled instance binds the detected provider", async (t) => {
  const rootDir = repoWithOrigin("https://github.com/example/repo.git");
  t.after(() => removeTemporaryDirectory(rootDir));
  const check = await hostedCredentialDoctorCheck(rootDir, { instances: [githubInstance] });
  assert.equal(check.id, "hosted-credential");
  assert.equal(check.status, "ok");
  assert.equal(check.count, 1);
  assert.match(check.summary, /daemon-held task push, PR creation, and CI reads are available/u);
});

test("doctor check warns with the configuration command when no enabled instance binds it", async (t) => {
  for (const [remote, provider] of [
    ["https://github.com/example/repo.git", "github"],
    ["https://gitlab.com/example/repo.git", "gitlab"],
  ] as const) {
    const rootDir = repoWithOrigin(remote);
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const disabledOnly = await hostedCredentialDoctorCheck(rootDir, {
      instances: [
        { ...githubInstance, enabled: false },
        { ...gitlabInstance, enabled: false },
      ],
    });
    assert.equal(disabledOnly.status, "warn", provider);
    assert.match(disabledOnly.summary, new RegExp(`No enabled runtime instance binds a ${provider}`, "u"));
    assert.equal(disabledOnly.next, `${hostingCredentialConfigurationAdvice(provider)}.`);
    // A binding for the other provider does not silence the warning.
    const otherProviderOnly = await hostedCredentialDoctorCheck(rootDir, {
      instances: [provider === "github" ? gitlabInstance : githubInstance],
    });
    assert.equal(otherProviderOnly.status, "warn", provider);
    assert.match(otherProviderOnly.next, new RegExp(`--provider ${provider} `, "u"));
  }
});

test("doctor check stays indeterminate when origin names no GitHub or GitLab host", async (t) => {
  for (const remote of ["https://source.example.internal/example/repo.git", "git@bitbucket.org:example/repo.git"]) {
    const rootDir = repoWithOrigin(remote);
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const check = await hostedCredentialDoctorCheck(rootDir, { instances: [githubInstance] });
    assert.equal(check.status, "indeterminate", remote);
    assert.match(check.next, /hosting\.provider and hosting\.host/u);
  }
});

test("the dispatch notice appears exactly when the repository has no provider credential", async (t) => {
  const rootDir = repoWithOrigin("https://github.com/example/repo.git");
  t.after(() => removeTemporaryDirectory(rootDir));
  assert.equal(await hostingCredentialDispatchNotice(rootDir, { instances: [githubInstance] }), null);
  const notice = await hostingCredentialDispatchNotice(rootDir, { instances: [] });
  assert.match(notice!, /cannot publish its branch, open the task PR, or read CI/u);
  assert.match(notice!, new RegExp(hostingCredentialConfigurationAdvice("github").replaceAll(".", "\\."), "u"));
});

test("the notice annotates only task-bound command receipts and preserves prior warnings", async (t) => {
  const rootDir = repoWithOrigin("https://github.com/example/repo.git");
  t.after(() => removeTemporaryDirectory(rootDir));
  const instances = { instances: [] as readonly unknown[] },
    receipt = { schema: "command-receipt/v2", ok: true, warnings: ["existing"] };
  // Unbound dispatches and dry-run previews owe no publication, so they pass through.
  assert.equal(await annotateHostingCredentialNotice(receipt, { taskId: undefined }, rootDir, instances), receipt);
  const preview = { schema: "agent-dispatch-preview/v1", ok: true };
  assert.equal(await annotateHostingCredentialNotice(preview, { taskId: "task_x" }, rootDir, instances), preview);
  const annotated = await annotateHostingCredentialNotice(receipt, { taskId: "task_x" }, rootDir, instances);
  assert.deepEqual(annotated.warnings, ["existing", await hostingCredentialDispatchNotice(rootDir, instances)]);
  // A configured repository leaves the receipt untouched.
  assert.equal(
    await annotateHostingCredentialNotice(receipt, { taskId: "task_x" }, rootDir, { instances: [githubInstance] }),
    receipt,
  );
});

test("spawn receipts carrying operator warnings still pass the protocol validator", () => {
  const pendingFacet = { state: "pending", cut: null },
    receipt = {
      schema: "command-receipt/v2",
      ok: true,
      command: "runtime-spawn",
      outcome: "pending",
      opId: "op-1",
      runtimeSessionId: "runtime_x",
      dispatchId: "dispatch_x",
      revision: 1,
      evidence: "event-object:op-1",
      visibility: "center",
      proof: {},
      cut: {},
      commitSha: null,
      status: "unknown",
      acceptance: null,
      projection: pendingFacet,
      git: { ...pendingFacet, commitSha: null },
      worktree: pendingFacet,
      replica: pendingFacet,
      warnings: ["No enabled runtime instance binds a github hosting credential."],
      authorizationDecision: null,
    };
  assert.deepEqual(validateRuntimeSpawnReceipt(receipt), []);
  assert.notDeepEqual(validateRuntimeSpawnReceipt({ ...receipt, unknownField: 1 }), []);
});
