import assert from "node:assert/strict";
import { bridgeReady } from "./helpers.mjs";

// 一个一次性邀请链接的假值:它不是任何中心的真实令牌,只用来驱动渲染进程的格式校验。
// 截图刻意避开输入框有值的时刻,设备登录页显示的是桩返回的假网址与假验证码。
const LINK = `harness-edge://join/${Buffer.from(
  JSON.stringify({ version: 1, joinId: "e2e-join", token: "e2e-dummy-token" }),
).toString("base64url")}`;

/**
 * 加入中心向导的无窗口端到端流程:粘贴 → 设备登录展示 → 逐仓进度 → 完成,以及一次错误态。
 *
 * 中心/Keycloak 不可在隔离 lane 里起真服务,所以场景在**主进程**替换 `harness:edge:join`
 * 的 IPC handler(渲染进程仍走真实 preload 与真实通道,`kind` 收窄由 preload 完成),
 * 用桩按真实 daemon 的返回形状回话。真实加入逻辑的测试在 daemon 的 edge-join-client 与
 * GUI 的 edge-join-entry-ipc.vitest。
 */
export default {
  id: "edge-join-entry",
  feature: "edge-join",
  lane: "isolated",
  description:
    "Open the join-center wizard from the project switcher, show the stubbed device sign-in, paint per-repository progress, finish, and show one plain-language refusal.",
  async run({ page, app, fixture, shot }) {
    await bridgeReady(page);

    await app.evaluate(
      ({ ipcMain }, { link, repoId }) => {
        const calls = [];
        let begins = 0;
        let polls = 0;
        const device = {
            ok: true,
            command: "edge-join",
            pending: true,
            verificationUri: "https://login.example.test/device",
            userCode: "ABCD-EFGH",
            interval: 1,
            expiresAt: Date.now() + 10 * 60_000,
          },
          joined = {
            ok: true,
            command: "edge-join",
            joinId: "e2e-join",
            state: "synced",
            repoIds: [repoId],
            repositories: [{ repoId, ok: true }],
            nodeId: "e2e-node",
            personId: "e2e-person",
          };
        globalThis.__edgeJoinCalls = calls;
        globalThis.__edgeJoinMode = "join";
        ipcMain.removeHandler("harness:edge:join");
        ipcMain.handle("harness:edge:join", async (_event, input) => {
          calls.push(input);
          if (input?.kind === "open-login") return { ok: true };
          if (input?.kind === "poll") {
            polls += 1;
            // 前两次仍待批准:保证设备登录页有稳定可见窗口供截图;之后批准。
            return polls <= 2 ? { ok: true, pending: true, interval: 1 } : { ok: true, pending: false };
          }
          if (input?.kind === "progress")
            return {
              ok: true,
              command: "edge-join",
              repositories: [{ repoId, phase: begins > 1 ? "sync" : "workspace" }],
            };
          if (input?.kind === "join") {
            if (input.link !== link) throw new Error("unexpected link");
            begins += 1;
            if (globalThis.__edgeJoinMode === "reject")
              return { ok: false, code: "pin_mismatch", rejectionExplanation: "center certificate pin mismatch" };
            if (begins === 1) return device;
            // 第二次调用代表逐仓库注册与首次同步;留出时间让进度读口画出「同步中」。
            await new Promise((resolve) => setTimeout(resolve, 2_200));
            return joined;
          }
          throw new Error(`unexpected edge join request: ${String(input?.kind)}`);
        });
      },
      { link: LINK, repoId: fixture.repoId },
    );

    await page.getByTestId("project-switcher").click();
    await page.getByTestId("quick-switcher-join-center").click();
    const wizard = page.getByTestId("edge-join-wizard");
    await wizard.waitFor();
    await shot("edge-join-paste");

    const input = page.getByTestId("edge-join-link-input");
    await input.fill("https://example.test/not-an-invitation");
    await page.getByTestId("edge-join-link-invalid").waitFor();
    assert.equal(await page.getByTestId("edge-join-start").isDisabled(), true);
    await input.fill(LINK);
    await page.getByTestId("edge-join-start").click();

    await page.getByTestId("edge-join-user-code").waitFor();
    assert.equal(await page.getByTestId("edge-join-user-code").innerText(), "ABCD-EFGH");
    assert.ok((await page.getByTestId("edge-join-login-uri").innerText()).startsWith("https://"));
    await shot("edge-join-device");
    await page.getByTestId("edge-join-open-login").click();

    await page.getByTestId("edge-join-repositories").waitFor();
    assert.match(await page.getByTestId("edge-join-repositories").innerText(), new RegExp(fixture.repoId, "u"));
    await shot("edge-join-joining");

    await page.getByTestId("edge-join-done").waitFor({ timeout: 15_000 });
    assert.match(await page.getByTestId("edge-join-repositories").innerText(), /Synced|已同步/u);
    await shot("edge-join-done");
    await page.getByTestId("edge-join-done").click();
    await wizard.waitFor({ state: "hidden" });

    // 错误态:同一向导第二次打开,桩改为中心证书指纹不符。
    await app.evaluate(() => {
      globalThis.__edgeJoinMode = "reject";
    });
    await page.getByTestId("project-switcher").click();
    await page.getByTestId("quick-switcher-join-center").click();
    await wizard.waitFor();
    await page.getByTestId("edge-join-link-input").fill(LINK);
    await page.getByTestId("edge-join-start").click();
    const message = page.getByTestId("edge-join-error-message");
    await message.waitFor();
    assert.match(await message.innerText(), /fingerprint|指纹/u);
    assert.match(await wizard.innerText(), /trusted administrator|受信任的管理员/u);
    await shot("edge-join-error");
    await page.getByTestId("edge-join-error-close").click();
    await wizard.waitFor({ state: "hidden" });

    // 协议激活:macOS 走 open-url,Windows/Linux 走第二个实例的 argv;两条都预填同一向导。
    // 截图不覆盖这一步(输入框会带假链接),只断言预填值。
    await app.evaluate(({ app: electronApp }, link) => {
      electronApp.emit("open-url", { preventDefault() {} }, link);
      electronApp.emit("second-instance", { preventDefault() {} }, ["/Applications/Harness.app", link]);
    }, LINK);
    await wizard.waitFor();
    assert.equal(await page.getByTestId("edge-join-link-input").inputValue(), LINK);
    await wizard.getByRole("button", { name: /^(?:关闭|Close)$/u }).click();
    await wizard.waitFor({ state: "hidden" });

    const calls = await app.evaluate(() => globalThis.__edgeJoinCalls);
    assert.equal(calls.filter((call) => call.kind === "join").length, 3);
    assert.ok(calls.every((call) => call.kind !== "join" || call.link === LINK));
    for (const kind of ["poll", "progress", "open-login"])
      assert.ok(
        calls.some((call) => call.kind === kind),
        kind,
      );

    const windows = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused() })),
    );
    assert.ok(windows.length > 0 && windows.every(({ visible, focused }) => !visible && !focused));
  },
};
