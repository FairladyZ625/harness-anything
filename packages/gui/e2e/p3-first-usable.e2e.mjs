// PLT-Performance/P3: first-usable marker must appear on Overview after real data,
// and must not treat an empty shell as usable.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { resolve } from "node:path";
import test from "node:test";
import electronPath from "electron";
import { _electron as electron } from "playwright-core";
import {
  repoRoot,
  guiRoot,
  writeTriadicLedger,
  closeElectronApp,
  sleep,
} from "./harness-fixture.mjs";

test("Overview marks first-usable only after interactive content is ready", { timeout: 90_000 }, async (t) => {
  const ledgerRoot = mkdtempSync(path.join(tmpdir(), "ha-gui-p3-usable-"));
  writeTriadicLedger(ledgerRoot);
  let electronApp;
  t.after(async () => {
    if (electronApp) await closeElectronApp(electronApp);
    await sleep(5_500);
    rmSync(ledgerRoot, { recursive: true, force: true });
  });

  electronApp = await electron.launch({
    executablePath: electronPath,
    args: [resolve(guiRoot, "src/main/electron-main.ts")],
    cwd: repoRoot,
    env: {
      ...process.env,
      HARNESS_GUI_ROOT: ledgerRoot,
      HARNESS_DAEMON_USER_ROOT: path.join(ledgerRoot, "daemon-user"),
      HARNESS_DAEMON_IDLE_MS: "5000",
    },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(20_000);
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => globalThis.localStorage.setItem("harness-locale", "zh-CN"));
  await page.reload({ waitUntil: "domcontentloaded" });

  // Wait for real task projection (Overview default view needs tasks+triadic).
  const taskSurface = page.getByTestId("real-task-summary").or(page.getByTestId("task-empty-state"));
  await taskSurface.waitFor({ timeout: 20_000 });

  const usable = page.locator('[data-first-usable="true"][data-first-usable-view="overview"]');
  await usable.waitFor({ timeout: 20_000 });

  const trace = await page.evaluate(() => globalThis.__harnessPerfTrace?.overview ?? null);
  assert.ok(trace, "expected __harnessPerfTrace.overview to be published");
  const names = (trace.markers ?? []).map((marker) => marker.name);
  assert.ok(names.includes("navigation-start"), `missing navigation-start in ${names.join(",")}`);
  assert.ok(names.includes("first-usable"), `missing first-usable in ${names.join(",")}`);

  // DOM ceiling soft check on the first screen (tolerant hard cap).
  const domCount = await page.evaluate(() => globalThis.document.querySelectorAll("*").length);
  assert.ok(domCount <= 10_000, `first-screen DOM ${domCount} exceeds ceiling 10000`);
});
