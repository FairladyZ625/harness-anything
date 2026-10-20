// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureApplicationsFolder,
  type ApplicationsFolderAppPort,
  type ApplicationsFolderDialogPort,
} from "../src/main/darwin-applications-folder.ts";

function createStubApp(overrides?: Partial<ApplicationsFolderAppPort>): {
  app: ApplicationsFolderAppPort;
  calls: {
    isInApplicationsFolder: number;
    moveToApplicationsFolder: Array<
      | {
          conflictHandler?: (conflictType: "exists" | "existsAndRunning") => boolean;
        }
      | undefined
    >;
  };
} {
  const calls = {
    isInApplicationsFolder: 0,
    moveToApplicationsFolder: [] as Array<
      | {
          conflictHandler?: (conflictType: "exists" | "existsAndRunning") => boolean;
        }
      | undefined
    >,
  };

  const app: ApplicationsFolderAppPort = {
    isPackaged: true,
    isInApplicationsFolder: () => {
      calls.isInApplicationsFolder++;
      return false;
    },
    moveToApplicationsFolder: (options) => {
      calls.moveToApplicationsFolder.push(options);
      return true;
    },
    ...overrides,
  };

  return { app, calls };
}

function createStubDialog(overrides?: { showMessageBoxResponse?: number; showMessageBoxSyncResponse?: number }): {
  dialog: ApplicationsFolderDialogPort;
  messageBoxes: Array<Parameters<ApplicationsFolderDialogPort["showMessageBox"]>[0]>;
  syncMessageBoxes: Array<Parameters<ApplicationsFolderDialogPort["showMessageBoxSync"]>[0]>;
} {
  const messageBoxes: Array<Parameters<ApplicationsFolderDialogPort["showMessageBox"]>[0]> = [];
  const syncMessageBoxes: Array<Parameters<ApplicationsFolderDialogPort["showMessageBoxSync"]>[0]> = [];

  const dialog: ApplicationsFolderDialogPort = {
    showMessageBox: async (options) => {
      messageBoxes.push(options);
      return { response: overrides?.showMessageBoxResponse ?? 0 };
    },
    showMessageBoxSync: (options) => {
      syncMessageBoxes.push(options);
      return overrides?.showMessageBoxSyncResponse ?? 0;
    },
  };

  return { dialog, messageBoxes, syncMessageBoxes };
}

test("darwin + 打包 + 不在应用程序目录：提示用户，用户选移动时调用 moveToApplicationsFolder 并返回 true", async () => {
  const { app, calls } = createStubApp();
  const { dialog, messageBoxes } = createStubDialog({ showMessageBoxResponse: 0 });

  const moved = await ensureApplicationsFolder({
    platform: "darwin",
    app,
    dialog,
  });

  assert.equal(moved, true);
  assert.equal(messageBoxes.length, 1);
  assert.equal(messageBoxes[0]?.buttons?.[0], "移动到「应用程序」");
  assert.equal(messageBoxes[0]?.buttons?.[1], "以后再说");
  assert.equal(calls.moveToApplicationsFolder.length, 1);
});

test("用户选「以后再说」：不调用 moveToApplicationsFolder，返回 false（继续启动）", async () => {
  const { app, calls } = createStubApp();
  const { dialog, messageBoxes } = createStubDialog({ showMessageBoxResponse: 1 });

  const moved = await ensureApplicationsFolder({
    platform: "darwin",
    app,
    dialog,
  });

  assert.equal(moved, false);
  assert.equal(messageBoxes.length, 1);
  assert.equal(calls.moveToApplicationsFolder.length, 0);
});

test("已在应用程序目录：不提示且不调用 moveToApplicationsFolder，返回 false", async () => {
  const { app, calls } = createStubApp({
    isInApplicationsFolder: () => true,
  });
  const { dialog, messageBoxes } = createStubDialog();

  const moved = await ensureApplicationsFolder({
    platform: "darwin",
    app,
    dialog,
  });

  assert.equal(moved, false);
  assert.equal(messageBoxes.length, 0);
  assert.equal(calls.moveToApplicationsFolder.length, 0);
});

test("非 darwin 平台：不提示且不调用 moveToApplicationsFolder，返回 false", async () => {
  const { app, calls } = createStubApp();
  const { dialog, messageBoxes } = createStubDialog();

  for (const platform of ["linux", "win32"] as const) {
    const moved = await ensureApplicationsFolder({
      platform,
      app,
      dialog,
    });
    assert.equal(moved, false);
  }

  assert.equal(messageBoxes.length, 0);
  assert.equal(calls.moveToApplicationsFolder.length, 0);
});

test("未打包（开发态）：不提示且不调用 moveToApplicationsFolder，返回 false", async () => {
  const { app, calls } = createStubApp({
    isPackaged: false,
  });
  const { dialog, messageBoxes } = createStubDialog();

  const moved = await ensureApplicationsFolder({
    platform: "darwin",
    app,
    dialog,
  });

  assert.equal(moved, false);
  assert.equal(messageBoxes.length, 0);
  assert.equal(calls.moveToApplicationsFolder.length, 0);
});

test("移动失败（抛出异常）：记录错误、显示原因并继续启动，不吞错", async () => {
  const loggedErrors: Array<{ message: string; error?: unknown }> = [];
  const { app } = createStubApp({
    moveToApplicationsFolder: () => {
      throw new Error("EACCES: permission denied, copyfile");
    },
  });
  const { dialog, messageBoxes } = createStubDialog({ showMessageBoxResponse: 0 });

  const moved = await ensureApplicationsFolder({
    platform: "darwin",
    app,
    dialog,
    logError: (message, error) => loggedErrors.push({ message, error }),
  });

  assert.equal(moved, false);
  assert.equal(messageBoxes.length, 2);
  assert.match(messageBoxes[1]?.message ?? "", /失败/u);
  assert.match(messageBoxes[1]?.detail ?? "", /EACCES: permission denied/u);
  assert.equal(loggedErrors.length, 1);
  assert.match(loggedErrors[0]?.message ?? "", /Failed to move/u);
});

test("移动失败（返回 false）：显示原因并继续启动", async () => {
  const loggedErrors: Array<{ message: string; error?: unknown }> = [];
  const { app } = createStubApp({
    moveToApplicationsFolder: () => false,
  });
  const { dialog, messageBoxes } = createStubDialog({ showMessageBoxResponse: 0 });

  const moved = await ensureApplicationsFolder({
    platform: "darwin",
    app,
    dialog,
    logError: (message, error) => loggedErrors.push({ message, error }),
  });

  assert.equal(moved, false);
  assert.equal(messageBoxes.length, 2);
  assert.match(messageBoxes[1]?.message ?? "", /未能移动/u);
  assert.equal(loggedErrors.length, 1);
});

test("conflictHandler 针对已存在同名应用（exists）：用户选择替换时返回 true", async () => {
  let capturedConflictHandler: ((conflictType: "exists" | "existsAndRunning") => boolean) | undefined;
  const { app } = createStubApp({
    moveToApplicationsFolder: (options) => {
      capturedConflictHandler = options?.conflictHandler;
      return true;
    },
  });
  const { dialog, syncMessageBoxes } = createStubDialog({
    showMessageBoxResponse: 0,
    showMessageBoxSyncResponse: 0, // 0 = "替换"
  });

  const moved = await ensureApplicationsFolder({
    platform: "darwin",
    app,
    dialog,
  });

  assert.equal(moved, true);
  assert.ok(capturedConflictHandler);
  const replaceResolution = capturedConflictHandler("exists");
  assert.equal(replaceResolution, true);
  assert.equal(syncMessageBoxes.length, 1);
  assert.match(syncMessageBoxes[0]?.message ?? "", /已存在同名应用/u);
});

test("conflictHandler 针对已存在同名应用（exists）：用户选择取消时返回 false 并提示未完成", async () => {
  const { app } = createStubApp({
    moveToApplicationsFolder: (options) => {
      const allowed = options?.conflictHandler?.("exists");
      return allowed ? true : false;
    },
  });
  const { dialog, messageBoxes, syncMessageBoxes } = createStubDialog({
    showMessageBoxResponse: 0,
    showMessageBoxSyncResponse: 1, // 1 = "取消"
  });

  const moved = await ensureApplicationsFolder({
    platform: "darwin",
    app,
    dialog,
  });

  assert.equal(moved, false);
  assert.equal(syncMessageBoxes.length, 1);
  assert.equal(messageBoxes.length, 2);
  assert.match(messageBoxes[1]?.detail ?? "", /已取消替换现有应用/u);
});

test("conflictHandler 针对正在运行的应用（existsAndRunning）：提示用户并返回 false", async () => {
  const { app } = createStubApp({
    moveToApplicationsFolder: (options) => {
      const allowed = options?.conflictHandler?.("existsAndRunning");
      return allowed ? true : false;
    },
  });
  const { dialog, messageBoxes, syncMessageBoxes } = createStubDialog({
    showMessageBoxResponse: 0,
  });

  const moved = await ensureApplicationsFolder({
    platform: "darwin",
    app,
    dialog,
  });

  assert.equal(moved, false);
  assert.equal(syncMessageBoxes.length, 1);
  assert.match(syncMessageBoxes[0]?.message ?? "", /正在运行/u);
  assert.equal(messageBoxes.length, 2);
  assert.match(messageBoxes[1]?.detail ?? "", /应用正在运行/u);
});
