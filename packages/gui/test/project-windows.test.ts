// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  createProjectWindowRegistry,
  projectWindowArgument,
  type ProjectWindowRegistryEntry,
} from "../src/main/project-windows.ts";
import { darwinAppMenuTemplate } from "../src/main/darwin-app-menu.ts";
import { registerProjectWindowIpc } from "../src/main/project-window-ipc.ts";
import {
  PROJECT_WINDOW_ACTIVE_CHANNEL,
  PROJECT_WINDOW_OPEN_CHANNEL,
  INITIAL_PROJECT_ARGUMENT_PREFIX,
  initialProjectFromArgv,
} from "../src/api/project-window-contract.ts";
import type { IpcMainInvokeEvent } from "electron";

/** 逐窗口假窗口:记录被创建时的初始项目、聚焦与关闭,供断言。 */
class FakeProjectWindow implements ProjectWindowRegistryEntry {
  readonly webContentsId: number;
  readonly initialRepoId: string | null;
  focusCount = 0;
  closed = false;
  private static nextId = 1;
  constructor(initialRepoId: string | null) {
    this.initialRepoId = initialRepoId;
    this.webContentsId = FakeProjectWindow.nextId++;
  }
  focus(): void {
    this.focusCount += 1;
  }
  onClosed(listener: () => void): void {
    this.closeHandlers.push(listener);
  }
  private readonly closeHandlers: (() => void)[] = [];
  close(): void {
    this.closed = true;
    for (const handler of this.closeHandlers.splice(0)) handler();
  }
}

function registry(focusWindows = true) {
  const created: FakeProjectWindow[] = [];
  const impl = createProjectWindowRegistry({
    createProjectWindow: (repoId) => {
      const window = new FakeProjectWindow(repoId);
      created.push(window);
      return window;
    },
    focusWindows,
  });
  return { impl, created };
}

test("openProjectWindow creates a window seeded with the repoId, then focuses that window on repeat", () => {
  const { impl, created } = registry();
  const first = impl.openProjectWindow("alpha");
  assert.equal(created.length, 1);
  assert.equal((first as FakeProjectWindow).initialRepoId, "alpha");

  // 同项目已开:聚焦既有窗口,不再建窗(「一个项目一个窗口」的判定核心)。
  const again = impl.openProjectWindow("alpha");
  assert.equal(again, first);
  assert.equal(created.length, 1);
  assert.equal((first as FakeProjectWindow).focusCount, 1);

  // 不同项目:另开一窗,各停各的项目。
  const second = impl.openProjectWindow("beta");
  assert.notEqual(second, first);
  assert.equal(created.length, 2);
  assert.equal((second as FakeProjectWindow).initialRepoId, "beta");
});

test("null repoId always opens a new default window (menu New Window without a project)", () => {
  const { impl, created } = registry();
  impl.openProjectWindow(null);
  impl.openProjectWindow(null);
  assert.equal(created.length, 2);
  assert.equal(
    created.every((window) => window.initialRepoId === null),
    true,
  );
});

test("setActiveProject retargets accounting when a window switches project in place", () => {
  const { impl, created } = registry();
  const first = impl.openProjectWindow("alpha") as FakeProjectWindow;
  impl.setActiveProject(first.webContentsId, "beta");
  assert.equal(impl.repoIdOf(first.webContentsId), "beta");

  // alpha 现在没有窗口停在它上面 → 新开;beta → 聚焦 first。
  impl.openProjectWindow("alpha");
  assert.equal(created.length, 2);
  impl.openProjectWindow("beta");
  assert.equal(created.length, 2);
  assert.equal(first.focusCount, 1);
  // 未知窗口的上报被忽略(表项只经 openProjectWindow 建立)。
  impl.setActiveProject(999, "gamma");
  assert.equal(impl.repoIdOf(999), null);
});

test("closed window leaves the registry, so its project opens a fresh window", () => {
  const { impl, created } = registry();
  const first = impl.openProjectWindow("alpha") as FakeProjectWindow;
  first.close();
  const second = impl.openProjectWindow("alpha");
  assert.equal(created.length, 2);
  assert.notEqual(second, first);
});

test("headless registry (focusWindows=false) never touches window visibility", () => {
  const { impl, created } = registry(false);
  const first = impl.openProjectWindow("alpha") as FakeProjectWindow;
  impl.openProjectWindow("alpha");
  assert.equal(created.length, 1);
  assert.equal(first.focusCount, 0);
});

test("initial project argument round-trips through argv and rejects malformed repoIds", () => {
  assert.equal(projectWindowArgument("alpha"), `${INITIAL_PROJECT_ARGUMENT_PREFIX}alpha`);
  assert.equal(initialProjectFromArgv(["electron", projectWindowArgument("alpha")]), "alpha");
  assert.equal(initialProjectFromArgv(["electron", "--no-sandbox"]), null);
  // 形状不合法(大写/斜杠/空)不当作项目,回落 null → 窗口走默认选仓。
  assert.equal(initialProjectFromArgv(["electron", `${INITIAL_PROJECT_ARGUMENT_PREFIX}Not-A-Repo`]), null);
  assert.equal(initialProjectFromArgv(["electron", `${INITIAL_PROJECT_ARGUMENT_PREFIX}a/b`]), null);
});

const trustedEvent = { sender: { id: 7 }, senderFrame: { url: "file:///renderer/index.html" } } as IpcMainInvokeEvent;
const policy = {
  isTrustedWebContentsId: (id: number) => id === 7,
  rendererUrl: { packagedRendererUrl: trustedEvent.senderFrame!.url },
};

function registered() {
  const opened: Array<string | null> = [];
  const active: Array<[number, string | null]> = [];
  const channels = new Map<string, (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>>();
  registerProjectWindowIpc(
    {
      handle: (channel, listener) => channels.set(channel, listener),
    },
    {
      openProjectWindow: (repoId) => opened.push(repoId),
      setActiveProject: (webContentsId, repoId) => active.push([webContentsId, repoId]),
    },
    policy,
  );
  return { channels, opened, active };
}

test("project window IPC routes exact repoId payloads and keys reports by sender id", async () => {
  const { channels, opened, active } = registered();
  await channels.get(PROJECT_WINDOW_OPEN_CHANNEL)!(trustedEvent, { repoId: "alpha" });
  assert.deepEqual(opened, ["alpha"]);
  await channels.get(PROJECT_WINDOW_ACTIVE_CHANNEL)!(trustedEvent, { repoId: "beta" });
  await channels.get(PROJECT_WINDOW_ACTIVE_CHANNEL)!(trustedEvent, { repoId: null });
  assert.deepEqual(active, [
    [7, "beta"],
    [7, null],
  ]);
});

test("project window IPC rejects malformed payloads and untrusted senders", async () => {
  const { channels } = registered();
  for (const payload of [{}, { repoId: "Not-A-Repo" }, { repoId: "alpha", extra: 1 }, null, "alpha"]) {
    await assert.rejects(() => channels.get(PROJECT_WINDOW_OPEN_CHANNEL)!(trustedEvent, payload), /repoId/u);
    await assert.rejects(() => channels.get(PROJECT_WINDOW_ACTIVE_CHANNEL)!(trustedEvent, payload), /repoId/u);
  }
  const untrusted = { sender: { id: 8 }, senderFrame: { url: trustedEvent.senderFrame!.url } } as IpcMainInvokeEvent;
  await assert.rejects(() => channels.get(PROJECT_WINDOW_OPEN_CHANNEL)!(untrusted, { repoId: "alpha" }), /Rejected/u);
});

test("darwin menu keeps system roles and adds File → New Window on ⌘⇧N", () => {
  let opened = 0;
  const template = darwinAppMenuTemplate(() => {
    opened += 1;
  });
  assert.deepEqual(
    template.map((item) => item.role),
    ["appMenu", undefined, "editMenu", "viewMenu", "windowMenu"],
  );
  const fileMenu = template[1];
  assert.equal(fileMenu.label, "文件");
  const newItem = fileMenu.submenu![0];
  assert.equal(newItem.label, "新建窗口");
  assert.equal(newItem.accelerator, "CmdOrCtrl+Shift+N");
  newItem.click!(undefined as never, undefined as never, undefined as never);
  assert.equal(opened, 1);
});
