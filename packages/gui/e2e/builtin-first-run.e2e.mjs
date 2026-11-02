/* global document, window */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startGuiDriver } from "../../../tools/gui-e2e/driver.mjs";

// This flow must start before any repository, account or Keycloak fixture exists.
// The only native dialog is stubbed; account creation, webview login and init use the GUI.
test("built-in GUI first account, login and first repository with an empty HOME", { timeout: 120_000 }, async () => {
  const workspaceRoot = path.resolve(import.meta.dirname, "../../.."),
    parent = mkdtempSync(path.join(tmpdir(), "hg-first-")),
    userRoot = path.join(parent, "user"),
    home = path.join(parent, "home"),
    rootDir = path.join(parent, "first-repository"),
    runRoot = process.env.HARNESS_GUI_E2E_SHOTS ?? path.join(parent, "shots"),
    originalEnv = { ...process.env };
  mkdirSync(home);
  mkdirSync(rootDir);
  mkdirSync(runRoot, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: tmpdir(),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_USER_ROOT: userRoot,
    HARNESS_DAEMON_ID: "first-run",
  };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  let daemon, driver;
  try {
    assert.equal(existsSync(userRoot), false);
    execFileSync("git", ["init", "--quiet", rootDir], { env });
    const { startDaemon } = await import("../../daemon/src/runtime.ts"),
      { readDaemonRegistry } = await import("@harness-anything/kernel");
    daemon = await startDaemon({ userRoot, daemonId: "first-run", runtimeDiscover: () => [] });
    assert.equal(readDaemonRegistry({ userRoot }).repos.length, 0);
    driver = await startGuiDriver({
      workspaceRoot,
      rootDir,
      env,
      runRoot,
      mainPath: path.join(workspaceRoot, "packages/gui/dist-electron/electron-main.js"),
    });
    const { page, app } = driver;
    const shot = (name) =>
      page.screenshot({ path: path.join(runRoot, `${name}.png`), fullPage: true, animations: "disabled" });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    await page.getByTestId("sidebar-account").click();
    await page.getByRole("tab", { name: /^(?:服务与会话|Service & session)$/u }).click();
    try {
      await page.getByTestId("bootstrap-admin-form").waitFor({ timeout: 5_000 });
    } catch (error) {
      await shot("bootstrap-form-failed");
      const alerts = await page.getByRole("alert").allTextContents();
      writeFileSync(path.join(runRoot, "bootstrap-failure.json"), JSON.stringify({ alerts, repositories: 0 }));
      throw error;
    }
    await shot("bootstrap-form");
    const form = page.getByTestId("bootstrap-admin-form"),
      password = randomBytes(24).toString("base64url");
    await form.locator('[name="username"]').fill("first-owner");
    await form.locator('[name="email"]').fill("owner@example.invalid");
    await form.locator('[name="displayName"]').fill("First Owner");
    await form.locator('[name="personId"]').fill("person-first-owner");
    await form.locator('[name="password"]').fill(password);
    await form.getByRole("button").click();
    await form.waitFor({ state: "hidden" });
    assert.equal(readDaemonRegistry({ userRoot }).repos.length, 0);
    await page.getByTestId("account-session-action").click();
    // Guest input travels through CDP, never through the system keyboard.
    await page.waitForFunction(() => document.querySelector("webview")?.getURL().includes("/login"));
    const guestId = await app.evaluate(
      ({ webContents }) => webContents.getAllWebContents().find((content) => content.getType() === "webview").id,
    );
    await app.evaluate(
      ({ webContents }, { guestId, password }) =>
        webContents.fromId(guestId).executeJavaScript(`
        document.querySelector('[name="username"]').value = "first-owner";
        document.querySelector('[name="password"]').value = ${JSON.stringify(password)};
        document.querySelector('form').requestSubmit();
      `),
      { guestId, password },
    );
    await page.getByTestId("identity-session").filter({ hasText: "person-first-owner" }).waitFor();
    await page.getByTestId("sidebar-account").filter({ hasText: "person-first-owner" }).waitFor();
    await page
      .getByTestId("sidebar-account")
      .filter({ hasText: /内置身份|Built-in identity/u })
      .waitFor();
    await shot("login-success");
    assert.equal((await page.evaluate(() => window.harness.auth.status())).authenticated, true);
    await page.getByRole("tab", { name: /^(?:我的设备|My devices)$/u }).click();
    await page.getByTestId("devices-local-mode").waitFor();
    assert.match(await page.getByTestId("my-devices").innerText(), /唯一设备|only device/u);
    assert.equal(await page.getByTestId("devices-security-boundary").count(), 0);
    await shot("my-devices");

    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, rootDir);
    await page.getByRole("button", { name: /^(?:设置|Settings)$/u }).click();
    await page.getByTestId("add-local-choose").click();
    await page.getByTestId("add-local-repo-id").fill("first-repository");
    await page.getByTestId("add-local-person-id").fill("person-first-owner");
    await page.getByTestId("add-local-display-name").fill("First Owner");
    await page.getByTestId("add-local-bootstrap").click();
    await page.getByTestId("add-local-bootstrap").waitFor({ state: "hidden", timeout: 30_000 });
    const repos = readDaemonRegistry({ userRoot }).repos;
    assert.equal(repos.length, 1);
    assert.equal(repos[0].repoId, "first-repository");
    assert.equal(repos[0].canonicalRoot, rootDir);
    assert.equal(existsSync(path.join(rootDir, "harness", "harness.yaml")), true);
    await page
      .getByTitle(/快速切换项目|Quickly switch projects/u)
      .filter({ hasText: "first-repository" })
      .waitFor({ timeout: 20_000 });
    await page.getByRole("button", { name: /^(?:设置|Settings)$/u }).click();
    await page.getByRole("button", { name: /仓库与连接|Repositories & connections/u }).click();
    await page.getByTestId("connection-repo-first-repository").waitFor();
    await shot("first-repository-initialized");
    await driver.assertBackground();
    driver.assertConsoleClean();
    writeFileSync(
      path.join(runRoot, "result.json"),
      JSON.stringify(
        {
          outcome: "passed",
          initialRepositories: 0,
          finalRepositories: 1,
          authenticated: true,
          personId: "person-first-owner",
          compiledMain: true,
          isolatedHome: true,
          isolatedUserRoot: true,
          nativeFolderDialog: "stubbed",
        },
        null,
        2,
      ),
    );
  } finally {
    try {
      await driver?.close();
      await daemon?.stop();
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, originalEnv);
      rmSync(parent, { recursive: true, force: true });
    }
  }
});
