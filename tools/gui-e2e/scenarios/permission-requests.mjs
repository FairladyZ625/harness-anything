import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { issueRuntimeExecutionCredential } from "../../../packages/daemon/src/runtime-execution-credential.ts";
import { openDaemonJsonRpcClientAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { KeycloakPolicyAdapter } from "../../../packages/daemon/src/keycloak-policy-adapter.ts";
import { keycloakUrl, keycloakRealm } from "../../../packages/daemon/test/keycloak.fixtures.ts";

export default {
  id: "permission-requests",
  feature: "identity-access",
  lane: "isolated",
  description: "Task-bound CLI self-request reaches the GUI and takes effect only after exact-version approval.",
  async run({ page, app, fixture, shot }) {
    const resource = `${fixture.repoId}:task/task-gui-smoke`,
      center = { url: keycloakUrl, realm: keycloakRealm, clientId: "harness-center", accessToken: "center-token" },
      credential = await issueRuntimeExecutionCredential(
        center,
        {
          personId: "person-ada",
          repoId: fixture.repoId,
          taskId: "task-gui-smoke",
          executionId: "permission-execution",
          runtimeSessionId: "permission-runtime",
          dispatchId: "permission-dispatch",
          role: "implementation",
          source: "local",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        fixture.keycloak.fetch,
      ),
      adapter = new KeycloakPolicyAdapter(
        { url: keycloakUrl, realm: keycloakRealm, resourceServerClientId: "harness-center" },
        fixture.keycloak.fetch,
      ),
      evaluate = () =>
        adapter.authorizePerson({
          adminAccessToken: "center-token",
          personId: "person-ada",
          action: "task-start",
          resource: { kind: "entity", repoId: fixture.repoId, entityRef: "task/task-gui-smoke" },
        });
    assert.equal((await evaluate()).outcome, "denied");
    const result = await promisify(execFile)(
      process.execPath,
      [
        path.resolve(import.meta.dirname, "../../../packages/cli/src/index.ts"),
        "--root",
        fixture.rootDir,
        "--json",
        "access",
        "request-create",
        "--group-id",
        "contributor",
        "--resource",
        resource,
        "--rationale",
        "Complete assigned task",
      ],
      {
        env: {
          ...process.env,
          ...fixture.env,
          HARNESS_EXECUTION_CREDENTIAL: credential,
          HARNESS_DAEMON_ENDPOINT: fixture.endpoint,
          HARNESS_CANONICAL_ROOT: fixture.rootDir,
          HARNESS_TASK_BOUND: "1",
        },
      },
    );
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.ok, true, result.stdout);
    assert.equal(receipt.request.personId, "person-ada");
    const request = receipt.request;
    const previous = process.env.HARNESS_EXECUTION_CREDENTIAL;
    let client;
    try {
      process.env.HARNESS_EXECUTION_CREDENTIAL = credential;
      client = await openDaemonJsonRpcClientAt(fixture.endpoint, 1000);
    } finally {
      if (previous === undefined) delete process.env.HARNESS_EXECUTION_CREDENTIAL;
      else process.env.HARNESS_EXECUTION_CREDENTIAL = previous;
    }
    try {
      const denied = await client.request("daemon.rbac.manage", {
        operation: "permission-request-decide",
        repoId: fixture.repoId,
        requestId: request.requestId,
        requestVersion: request.version,
        decision: "approve",
      });
      assert.equal(denied.code, "execution_credential_rejected");
    } finally {
      client.close();
    }
    await page.getByRole("button", { name: /^(?:账号与访问控制|Identity & access)$/u }).click();
    // 双语标签:隔离夹具按 daemon 设置渲染 zh-CN,en-US 只在显式切语言后出现。
    await page.getByRole("tab", { name: /^(?:Permission requests|权限申请)$/u }).click();
    await page.getByTestId(`permission-request-decide-${request.requestId}`).click();
    assert.match(await page.getByTestId("permission-request-confirm").textContent(), /Confirm version 1/u);
    assert.equal((await evaluate()).outcome, "denied");
    await shot("permission-exact-version");
    await page.getByTestId("permission-request-approve").click();
    await page.getByTestId("permission-request-confirm").waitFor({ state: "detached" });
    assert.equal((await evaluate()).outcome, "allowed");
    const form = page.getByTestId("permission-request-create");
    await form.getByLabel(/^(?:Resource|作用域)$/u).fill(fixture.repoId);
    await form.getByLabel(/^(?:Reason|申请理由)$/u).fill("Inspect repository");
    await form.getByRole("button", { name: /^(?:Request access|提交申请)$/u }).click();
    await page
      .getByTestId("permission-requests")
      .getByText(/person-gui (?:requests|申请了)/u)
      .waitFor();
    for (const width of [1440, 1120]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size, 900), width);
      await shot(`permission-request-${width}`);
    }
    assert.deepEqual(
      await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0];
        return { visible: w.isVisible(), focused: w.isFocused() };
      }),
      { visible: false, focused: false },
    );
  },
};
