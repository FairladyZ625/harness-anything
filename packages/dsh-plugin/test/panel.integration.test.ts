// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { chromium } from "playwright-core";
import { build } from "vite";
import { BROKER_ROUTE, createBrokerManager } from "../src/broker.ts";

const require = createRequire(import.meta.url);

test("main tabs retain the iframe, share the Host process, and expose failure recovery and the browser alternative", async (t) => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-dsh-panel-"));
  const resources: { browser?: Awaited<ReturnType<typeof chromium.launch>> } = {};
  let origin = "";
  let fail = false;
  let launches = 0;
  const manager = createBrokerManager(
    {
      spawn() {
        launches += 1;
        const stdout = new PassThrough();
        let finish!: (value: { exitCode: number; signal: null }) => void;
        const done = new Promise<{ exitCode: number; signal: null }>((resolve) => {
          finish = resolve;
        });
        queueMicrotask(() =>
          stdout.write(
            JSON.stringify(
              fail
                ? { ok: false, error: { code: "invalid_field", hint: "Upgrade the CLI, then retry." } }
                : { ok: true, url: `${origin}/gui` },
            ),
          ),
        );
        return { stdout, done, terminate: () => finish({ exitCode: 0, signal: null }) };
      },
    },
    { getWorkspace: () => "/fixture", getParentOrigin: () => origin },
  );
  const server = createServer((request, response) => {
    if (request.url === BROKER_ROUTE) {
      void manager.handle(request, response);
      return;
    }
    response.setHeader("Content-Type", request.url === "/fixture.js" ? "text/javascript" : "text/html");
    response.end(
      request.url === "/fixture.js"
        ? readFileSync(path.join(scratch, "dist/fixture.js"))
        : request.url === "/gui"
          ? '<!doctype html><label>Frame state<input aria-label="Frame state"></label>'
          : '<!doctype html><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="/fixture.js"></script>',
    );
  });
  t.after(async () => {
    await resources.browser?.close();
    await manager.dispose();
    if (server.listening)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    rmSync(scratch, { recursive: true, force: true });
  });
  const entry = path.join(scratch, "fixture.ts");
  writeFileSync(
    entry,
    `
    import { createElement } from ${JSON.stringify(require.resolve("react"))};
    import { createRoot } from ${JSON.stringify(require.resolve("react-dom/client"))};
    import { HarnessPanel, openHarnessBrowser } from ${JSON.stringify(path.resolve("packages/dsh-plugin/src/client.ts"))};
    import { tutorialCopy } from ${JSON.stringify(path.resolve("packages/dsh-plugin/src/tutorial-content.ts"))};
    const ctx = {
      layout: { selectPanel: value => { document.body.dataset.selectedPanel = String(value); } },
      sidebarRight: { openTab: () => { document.body.dataset.browserOpened = 'true'; } },
    };
    createRoot(document.getElementById('root')).render(createElement(HarnessPanel, {
      tutorialTab: "教程", copy: tutorialCopy.zh, onOpen: () => void openHarnessBrowser(ctx),
    }));
  `,
  );
  await build({
    configFile: false,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      outDir: path.join(scratch, "dist"),
      emptyOutDir: true,
      lib: { entry, name: "Fixture", formats: ["iife"], fileName: () => "fixture.js" },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  resources.browser = await chromium.launch({ headless: true });
  const page = await resources.browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  const tabs = page.getByRole("tablist", { name: "Harness", exact: true });
  assert.equal(await tabs.getByRole("tab").count(), 2);
  assert.equal(await tabs.getByRole("tab", { name: "教程", exact: true }).getAttribute("aria-selected"), "true");
  await tabs.getByRole("tab", { name: "Harness", exact: true }).click();
  const frame = page.frameLocator('iframe[title="Harness GUI"]');
  await frame.getByRole("textbox", { name: "Frame state" }).fill("retained");
  await tabs.getByRole("tab", { name: "教程", exact: true }).click();
  await tabs.getByRole("tab", { name: "教程", exact: true }).press("ArrowRight");
  assert.equal(await frame.getByRole("textbox", { name: "Frame state" }).inputValue(), "retained");
  assert.equal(launches, 1);

  await manager.dispose();
  fail = true;
  await page.reload();
  await tabs.getByRole("tab", { name: "Harness", exact: true }).click();
  await page.getByRole("alert").waitFor();
  assert.match(await page.getByRole("alert").innerText(), /invalid_field: Upgrade the CLI, then retry\./u);
  assert.equal(launches, 2);
  fail = false;
  await page.getByRole("button", { name: "在内置浏览器打开", exact: true }).click();
  await page.waitForFunction(() => document.body.dataset.browserOpened === "true");
  assert.equal(await page.locator("body").getAttribute("data-selected-panel"), "null");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await frame.getByRole("textbox", { name: "Frame state" }).waitFor();
  assert.equal(launches, 3, "retry and browser alternative share the recovered Host process");
  assert.deepEqual(errors, []);
});
