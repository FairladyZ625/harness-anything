// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createBrokerManager, type BrokerSubprocessHandle, type BrokerSubprocessRuntime } from "../src/broker.ts";
import { apply as applyClient, openHarnessBrowser } from "../src/client.ts";

test("bundle client externals do not request the plugin's own client module", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    readonly name?: string;
    readonly dsh?: { readonly client?: { readonly external?: readonly string[] } };
  };
  assert.ok(manifest.name);
  assert.equal(manifest.dsh?.client?.external?.includes(`${manifest.name}/client`), false);
});

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

interface ClientRegistration {
  readonly options: Record<string, unknown>;
  readonly component: (props: never) => unknown;
  disposed: boolean;
}

interface ClientInjection {
  readonly name: string;
  readonly dispose: () => void;
}

function clientHarness(): {
  readonly ctx: Record<string, unknown>;
  readonly registrations: ClientRegistration[];
  readonly injections: ClientInjection[];
  readonly selectedPanels: Array<string | null>;
  readonly cleanupEffects: () => void;
} {
  const registrations: ClientRegistration[] = [];
  const injections: ClientInjection[] = [];
  const selectedPanels: Array<string | null> = [];
  const cleanups: Array<() => void> = [];
  let insideInjection = false;
  const register = (options: Record<string, unknown>, component: (props: never) => unknown): (() => void) => {
    assert.equal(insideInjection, true, "slot registrations must be owned by slots.inject");
    const entry: ClientRegistration = { options, component, disposed: false };
    registrations.push(entry);
    return () => {
      entry.disposed = true;
    };
  };
  const ctx = {
    locale: {
      register: () => () => {},
      bind: () => (key: string) => key,
    },
    effect: (factory: () => unknown) => {
      const cleanup = factory();
      if (typeof cleanup === "function") cleanups.push(cleanup as () => void);
      return cleanup;
    },
    slots: {
      inject: (name: string, factory: () => (() => void) | void) => {
        insideInjection = true;
        const disposeRegistration = factory();
        insideInjection = false;
        const injection: ClientInjection = {
          name,
          dispose: () => {
            disposeRegistration?.();
          },
        };
        injections.push(injection);
        return injection.dispose;
      },
      register,
    },
    sidebarRight: { openTab() {} },
    layout: { selectPanel: (panelId: string | null) => selectedPanels.push(panelId) },
    logger: { info() {}, warn() {} },
  } as Record<string, unknown>;
  return {
    ctx,
    registrations,
    injections,
    selectedPanels,
    cleanupEffects: () => {
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
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
  const harness = clientHarness();
  const { registrations, selectedPanels } = harness;
  const clicks: Array<{ readonly kind: string; readonly url: string }> = [];
  const ctx = {
    ...harness.ctx,
    sidebarRight: {
      openTab: (kind: string, options: { readonly params: { readonly url: string } }) =>
        clicks.push({ kind, url: options.params.url }),
    },
  } as never;
  applyClient(ctx);
  const iconRegistration = registrations.find((entry) => entry.options.name === "sidebar.panellist");
  assert.ok(iconRegistration);
  const fetcher: typeof fetch = async () =>
    new Response(JSON.stringify({ ok: true, url: "http://127.0.0.1:4321/" }), { status: 200 });
  const icon = iconRegistration.component({ size: 16, active: false } as never) as {
    readonly props: { readonly onClick?: () => Promise<void> };
  };
  assert.equal(icon.props.onClick, undefined, "the sidebar entry only selects the tutorial panel");
  await openHarnessBrowser(ctx, fetcher);
  assert.deepEqual(selectedPanels, [null]);
  assert.deepEqual(clicks, [{ kind: "browser", url: "http://127.0.0.1:4321/" }]);
});

test("client displays broker code and hint in the shell overlay on failure", async () => {
  const harness = clientHarness();
  const { ctx, registrations, injections } = harness;
  applyClient(ctx as never);
  const mainRegistration = registrations.find((entry) => entry.options.name === "main");
  assert.ok(mainRegistration);
  const tutorial = mainRegistration.component({} as never) as { readonly props: { readonly onOpen: () => void } };
  const openButton = { props: { onClick: tutorial.props.onOpen } };
  const previousFetch = globalThis.fetch;
  const receipts = [
    { code: "ha_unavailable", hint: "Install ha CLI and retry." },
    { code: "daemon_start_failed", hint: "Start the local daemon, then retry." },
  ];
  globalThis.fetch = async () => {
    const error = receipts.shift();
    assert.ok(error);
    return new Response(JSON.stringify({ ok: false, error }), { status: 503 });
  };
  try {
    openButton.props.onClick();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    openButton.props.onClick();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  } finally {
    globalThis.fetch = previousFetch;
  }
  const notice = registrations.find((entry) => entry.options.id === "harness-anything.broker-error");
  assert.ok(notice);
  const inject = notice.options.inject;
  assert.equal(typeof inject, "function");
  const face = (
    inject as () => {
      readonly hooks: {
        readonly failure: { readonly getSnapshot: () => { readonly code: string; readonly hint: string } | null };
      };
      readonly dismiss: () => void;
    }
  )();
  const rendered = notice.component({
    useFailure: (selector: (value: { readonly code: string; readonly hint: string } | null) => unknown) =>
      selector(face.hooks.failure.getSnapshot()),
    dismiss: face.dismiss,
  } as never) as {
    readonly props: { readonly role: string; readonly children: readonly unknown[] };
  };
  assert.equal(rendered.props.role, "alert");
  assert.match(JSON.stringify(rendered), /daemon_start_failed/);
  assert.match(JSON.stringify(rendered), /Start the local daemon, then retry/);
  assert.doesNotMatch(JSON.stringify(rendered), /ha_unavailable/);
  const dismiss = rendered.props.children[2] as { readonly props: { readonly onClick: () => void } };
  dismiss.props.onClick();
  assert.equal(face.hooks.failure.getSnapshot(), null);
  const overlayInjection = injections.find((entry) => entry.name === "shell.overlay");
  assert.ok(overlayInjection);
  overlayInjection.dispose();
  assert.equal(notice.disposed, true, "injection disposal removes the overlay registration");
});

test("client retries opening the browser tab until the session seat mounts", async () => {
  const harness = clientHarness();
  let attempts = 0;
  const opened: string[] = [];
  const ctx = {
    ...harness.ctx,
    sidebarRight: {
      openTab: (_kind: string, options: { readonly params: { readonly url: string } }) => {
        attempts += 1;
        if (attempts < 3) throw new Error("no session surface is mounted");
        opened.push(options.params.url);
      },
    },
  } as never;
  const fetcher: typeof fetch = async () =>
    new Response(JSON.stringify({ ok: true, url: "http://127.0.0.1:4321/" }), { status: 200 });
  await openHarnessBrowser(ctx, fetcher);
  assert.equal(attempts, 3);
  assert.deepEqual(opened, ["http://127.0.0.1:4321/"]);
});
