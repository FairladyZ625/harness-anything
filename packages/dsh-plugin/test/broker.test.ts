// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { createBrokerManager, type BrokerSubprocessHandle, type BrokerSubprocessRuntime } from "../src/broker.ts";
import { apply as applyClient, openHarnessBrowser } from "../src/client.ts";

interface FakeStream {
  listeners: Array<(value: unknown) => void>;
  on(event: "data" | "end" | "error", listener: (...args: readonly unknown[]) => void): void;
  emit(value: unknown): void;
}

function stream(): FakeStream {
  const listeners: Array<(value: unknown) => void> = [];
  return {
    listeners,
    on(event, listener) {
      if (event === "data") listeners.push(listener);
    },
    emit(value) {
      for (const listener of listeners) listener(value);
    },
  };
}

interface Child {
  readonly stdout: FakeStream;
  readonly stderr: FakeStream;
  readonly handle: BrokerSubprocessHandle;
  resolve(outcome?: { readonly exitCode: number | null; readonly signal: string | null }): void;
  readonly terminated: { value: boolean };
}

function child(): Child {
  const stdout = stream();
  const stderr = stream();
  let resolveDone!: (outcome: { readonly exitCode: number | null; readonly signal: string | null }) => void;
  const terminated = { value: false };
  const handle: BrokerSubprocessHandle = {
    stdout,
    stderr,
    done: new Promise((resolve) => {
      resolveDone = resolve;
    }),
    terminate: () => {
      terminated.value = true;
      resolveDone({ exitCode: null, signal: "SIGTERM" });
    },
  };
  return { stdout, stderr, handle, resolve: resolveDone, terminated };
}

test("broker launches ha gui with the workspace and reuses the URL", async () => {
  let workspace = "/repo";
  const children: Child[] = [];
  const subprocess: BrokerSubprocessRuntime = {
    spawn(spec) {
      assert.deepEqual(spec.argv, ["ha", "gui", "--browser", "--root", spec.cwd, "--json"]);
      const current = child();
      children.push(current);
      queueMicrotask(() => current.stdout.emit('{"ok":true,"url":"http://127.0.0.1:4040/#token","summary":"ready"}\n'));
      return current.handle;
    },
  };
  const manager = createBrokerManager(subprocess, { getWorkspace: () => workspace });
  assert.deepEqual(await manager.ensure(), { ok: true, url: "http://127.0.0.1:4040/#token", summary: "ready" });
  assert.deepEqual(await manager.ensure(), { ok: true, url: "http://127.0.0.1:4040/#token" });
  assert.equal(children.length, 1);
  workspace = "/other";
  assert.deepEqual(await manager.ensure(), { ok: true, url: "http://127.0.0.1:4040/#token", summary: "ready" });
  assert.equal(children.length, 2);
  assert.equal(children[0]?.terminated.value, true);
  await manager.dispose();
  assert.equal(children[1]?.terminated.value, true);
});

test("broker forwards missing CLI and uninitialized repository code and hint", async () => {
  for (const receipt of [
    '{"ok":false,"error":{"code":"ha_unavailable","hint":"Install ha CLI."}}\n',
    '{"ok":false,"error":{"code":"repository_uninitialized","hint":"Run ha init."}}\n',
  ]) {
    const current = child();
    const manager = createBrokerManager({ spawn: () => current.handle }, { getWorkspace: () => "/repo" });
    queueMicrotask(() => current.stdout.emit(receipt));
    const result = await manager.ensure();
    assert.deepEqual(result, JSON.parse(receipt));
    assert.equal(current.terminated.value, true);
  }
});

test("broker preserves the CLI top-level daemon failure code and diagnostic hint", async () => {
  const current = child();
  const manager = createBrokerManager({ spawn: () => current.handle }, { getWorkspace: () => "/repo" });
  queueMicrotask(() =>
    current.stdout.emit(
      '{"ok":false,"code":"daemon_start_failed","diagnostic":{"expectation":"Start the local daemon, then retry ha gui."}}\n',
    ),
  );
  assert.deepEqual(await manager.ensure(), {
    ok: false,
    error: { code: "daemon_start_failed", hint: "Start the local daemon, then retry ha gui." },
  });
  assert.equal(current.terminated.value, true);
});

test("disposing while ha is starting terminates the pending child", async () => {
  const current = child();
  const manager = createBrokerManager({ spawn: () => current.handle }, { getWorkspace: () => "/repo" });
  const pending = manager.ensure();
  await manager.dispose();
  assert.equal(current.terminated.value, true);
  assert.deepEqual(await pending, {
    ok: false,
    error: { code: "ha_unavailable", hint: "ha gui exited with code unknown" },
  });
});

test("client registration opens the built-in browser with the broker URL", async () => {
  const registrations: Array<{
    readonly options: Record<string, unknown>;
    readonly component: (props: never) => unknown;
  }> = [];
  const clicks: Array<{ readonly kind: string; readonly url: string }> = [];
  const ctx = {
    locale: {
      register: () => () => {},
      bind: () => (key: string) => key,
    },
    effect: (factory: () => unknown) => factory(),
    slots: {
      inject: (_name: string, factory: () => () => void) => factory(),
      register: (options: Record<string, unknown>, component: (props: never) => unknown) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
    sidebarRight: {
      openTab: (kind: string, options: { readonly params: { readonly url: string } }) =>
        clicks.push({ kind, url: options.params.url }),
    },
    logger: { info() {}, warn() {} },
  } as never;
  applyClient(ctx);
  const iconRegistration = registrations.find((entry) => entry.options.name === "sidebar.panellist");
  assert.ok(iconRegistration);
  const fetcher: typeof fetch = async () =>
    new Response(JSON.stringify({ ok: true, url: "http://127.0.0.1:4321/" }), { status: 200 });
  await openHarnessBrowser(ctx, fetcher);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    const icon = iconRegistration.component({ size: 16, active: false } as never) as {
      readonly props: { readonly onClick: () => Promise<void> };
    };
    await icon.props.onClick();
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.deepEqual(clicks, [
    { kind: "browser", url: "http://127.0.0.1:4321/" },
    { kind: "browser", url: "http://127.0.0.1:4321/" },
  ]);
});

test("client displays broker code and hint in the shell overlay on failure", async () => {
  const registrations: Array<{
    readonly options: Record<string, unknown>;
    readonly component: (props: never) => unknown;
  }> = [];
  const ctx = {
    locale: {
      register: () => () => {},
      bind: () => (key: string) => key,
    },
    effect: (factory: () => unknown) => factory(),
    slots: {
      inject: (_name: string, factory: () => () => void) => factory(),
      register: (options: Record<string, unknown>, component: (props: never) => unknown) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
    sidebarRight: { openTab() {} },
    logger: { info() {}, warn() {} },
  } as never;
  applyClient(ctx);
  const iconRegistration = registrations.find((entry) => entry.options.name === "sidebar.panellist");
  assert.ok(iconRegistration);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        ok: false,
        error: { code: "ha_unavailable", hint: "Install ha CLI and retry." },
      }),
      { status: 503 },
    );
  try {
    const icon = iconRegistration.component({ size: 16, active: false } as never) as {
      readonly props: { readonly onClick: () => Promise<void> };
    };
    await icon.props.onClick();
  } finally {
    globalThis.fetch = previousFetch;
  }
  const notice = registrations.find((entry) => entry.options.name === "shell.overlay");
  assert.ok(notice);
  const rendered = notice.component({} as never) as {
    readonly props: { readonly role: string; readonly children: unknown };
  };
  assert.equal(rendered.props.role, "alert");
  assert.match(JSON.stringify(rendered), /ha_unavailable/);
  assert.match(JSON.stringify(rendered), /Install ha CLI and retry/);
});
