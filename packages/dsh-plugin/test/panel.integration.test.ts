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

test("open here asks once for the default view, keeps the board alive, and shares the Host process with open beside session", async (t) => {
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
    { resolveWorkspace: async () => "/fixture", getParentOrigin: () => origin },
  );
  const server = createServer((request, response) => {
    if (request.url === BROKER_ROUTE) {
      void manager.handle(request, response);
      return;
    }
    response.setHeader(
      "Content-Type",
      request.url === "/fixture.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
    );
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
      sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
    };
    createRoot(document.getElementById('root')).render(createElement(HarnessPanel, {
      copy: tutorialCopy.zh, getWorkspace: () => undefined, onOpenBeside: () => void openHarnessBrowser(ctx),
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
  // CI runners and developer Macs ship system Chrome; Playwright downloads no browser here.
  resources.browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await resources.browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  const tutorial = page.getByTestId("harness-tutorial-view");
  const board = page.getByTestId("harness-board-view");
  assert.equal(await board.isVisible(), false, "first open shows the tutorial");
  await tutorial.getByRole("button", { name: "在这里打开", exact: true }).click();
  const frame = page.frameLocator('iframe[title="Harness GUI"]');
  await frame.getByRole("textbox", { name: "Frame state" }).fill("retained");
  const ask = board.getByRole("group", { name: "以后点开插件，直接显示看板？" });
  await ask.getByRole("button", { name: "是，默认看板", exact: true }).click();
  await ask.waitFor({ state: "detached" });
  assert.equal(await ask.count(), 0, "the default-view question is asked once");
  await board.getByRole("button", { name: "← 教程", exact: true }).click();
  await tutorial.waitFor();
  await tutorial.getByRole("button", { name: "在这里打开", exact: true }).click();
  assert.equal(await frame.getByRole("textbox", { name: "Frame state" }).inputValue(), "retained");
  assert.equal(launches, 1);

  await manager.dispose();
  fail = true;
  await page.reload();
  await board.getByRole("alert").waitFor();
  assert.equal(await tutorial.isVisible(), false, "the saved preference opens the board directly");
  assert.match(await board.getByRole("alert").innerText(), /invalid_field: Upgrade the CLI, then retry\./u);
  assert.equal(launches, 2);
  fail = false;
  await board.getByRole("button", { name: "在会话旁打开", exact: true }).click();
  await page.waitForFunction(() => document.body.dataset.browserOpened === "true");
  assert.equal(await page.locator("body").getAttribute("data-selected-panel"), "null");
  await board.getByRole("button", { name: "重试", exact: true }).click();
  await frame.getByRole("textbox", { name: "Frame state" }).waitFor();
  assert.equal(launches, 3, "retry and the beside-session browser share the recovered Host process");
  assert.deepEqual(errors, []);
});
