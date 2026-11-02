import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import electronPath from "electron";
import { _electron as electron } from "playwright-core";
import { BuiltinIdentitySession } from "@harness-anything/authorization-builtin";

test(
  "device approval delivers a complete success page and readable failures in a hidden browser",
  { timeout: 30_000 },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "hg-device-")),
      root = path.join(parent, "user"),
      runRoot = process.env.HARNESS_GUI_E2E_SHOTS ?? path.join(parent, "shots"),
      session = new BuiltinIdentitySession(root),
      password = randomBytes(24).toString("base64url"),
      main = path.join(parent, "main.cjs");
    mkdirSync(runRoot, { recursive: true });
    await session.bootstrapAdmin({
      username: "owner",
      email: "owner@example.invalid",
      displayName: "Owner",
      personId: "person-owner",
      password,
    });
    const begun = await session.beginDevice();
    writeFileSync(
      main,
      `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const win=new BrowserWindow({show:false,width:620,height:780,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});win.loadURL(process.env.HARNESS_DEVICE_URL);});`,
    );
    let app;
    try {
      app = await electron.launch({
        executablePath: electronPath,
        args: [main, `--user-data-dir=${path.join(parent, "profile")}`, "--no-sandbox", "--headless", "--disable-gpu"],
        env: { PATH: process.env.PATH, HOME: parent, HARNESS_DEVICE_URL: String(begun.verificationUri) },
      });
      const page = await app.firstWindow();
      page.setDefaultTimeout(5_000);
      await page.waitForLoadState("load");
      await page.screenshot({ path: path.join(runRoot, "device-form.png") });
      await page.getByLabel("Username", { exact: true }).fill("owner");
      await page.getByLabel("Password", { exact: true }).fill(password);
      const delivered = page.waitForResponse((response) => response.request().method() === "POST");
      const started = Date.now();
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      const response = await delivered;
      assert.equal(response.status(), 200);
      const approved = await session.pollDevice();
      assert.equal(approved.authenticated, true);
      assert.equal(await response.finished(), null);
      await page.waitForLoadState("load");
      writeFileSync(
        path.join(runRoot, "device-response.json"),
        JSON.stringify(
          {
            responseStatus: response.status(),
            responseComplete: true,
            responseCompleteAfterApproval: true,
            authenticated: true,
            responseMs: Date.now() - started,
            body: await page.locator("body").innerText(),
          },
          null,
          2,
        ),
      );
      await page.screenshot({ path: path.join(runRoot, "device-success.png") });
      await page.getByRole("heading", { name: "You're signed in", exact: true }).waitFor();
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({ path: path.join(runRoot, "device-success-dark.png") });
      await page.emulateMedia({ colorScheme: "light" });
      const failed = await session.beginDevice();
      await page.goto(String(failed.verificationUri));
      await page.getByLabel("Username", { exact: true }).fill("owner");
      await page.getByLabel("Password", { exact: true }).fill("incorrect-fixture-password");
      const refused = page.waitForResponse((response) => response.request().method() === "POST");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      assert.equal((await refused).status(), 401);
      await page.getByRole("heading", { name: "Check your sign-in details" }).waitFor();
      assert.equal(await page.getByLabel("Password", { exact: true }).inputValue(), "");
      assert.equal((await session.pollDevice()).pending, true);
      await page.screenshot({ path: path.join(runRoot, "device-failure.png") });
      const expired = await session.beginDevice(undefined, undefined, Date.now() - 1);
      const expiry = await page.goto(String(expired.verificationUri));
      assert.equal(expiry.status(), 410);
      await page.getByRole("heading", { name: "Sign-in link expired" }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Sign in", exact: true }).count(), 0);
      await page.screenshot({ path: path.join(runRoot, "device-expired.png") });
      const expiredPost = await page.request.post(String(expired.verificationUri), {
        form: { username: "owner", password, userCode: String(expired.userCode) },
      });
      assert.equal(expiredPost.status(), 410);
      await assert.rejects(session.pollDevice(), { code: "oidc_device_expired" });
      const windows = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused() })),
      );
      assert.ok(windows.length && windows.every((window) => !window.visible && !window.focused));
      writeFileSync(path.join(runRoot, "window-state.json"), JSON.stringify(windows));
    } finally {
      await app?.close();
      rmSync(parent, { recursive: true, force: true });
    }
  },
);
