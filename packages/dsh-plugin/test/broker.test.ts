// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  chooseWorkspace,
  createBrokerManager,
  readRegisteredRepos,
  type BrokerSubprocessHandle,
  type BrokerSubprocessRuntime,
} from "../src/broker.ts";
import { apply as applyHost } from "../src/index.ts";
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

/** Let the manager's asynchronous Workspace resolution reach its spawn. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

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
    sessions: {
      list: {
        getSnapshot: () => ({
          byId: {
            other: { cwd: "/elsewhere", retainedBy: {} },
            main: { cwd: "/selected", retainedBy: { mainView: 1 } },
          },
        }),
      },
    },
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
  const children: Child[] = [];
  const subprocess: BrokerSubprocessRuntime = {
    spawn(spec) {
      assert.deepEqual(spec.argv, [
        "ha",
        "gui",
        "--browser",
        "--parent-origin",
        "dsh-app://app",
        "--root",
        spec.cwd,
        "--json",
      ]);
      const current = child();
      children.push(current);
      queueMicrotask(() => current.stdout.emit('{"ok":true,"url":"http://127.0.0.1:4040/#token","summary":"ready"}\n'));
      return current.handle;
    },
  };
  const resolved: Array<string | undefined> = [];
  const manager = createBrokerManager(subprocess, {
    getParentOrigin: () => "dsh-app://app",
    resolveWorkspace: async (requested) => {
      resolved.push(requested);
      return requested ?? "/repo";
    },
  });
  assert.deepEqual(await manager.ensure(), { ok: true, url: "http://127.0.0.1:4040/#token", summary: "ready" });
  assert.deepEqual(await manager.ensure(), { ok: true, url: "http://127.0.0.1:4040/#token" });
  assert.deepEqual(await manager.ensure("/repo"), { ok: true, url: "http://127.0.0.1:4040/#token" });
  assert.equal(children.length, 1, "a request resolving to the running root reuses its broker");
  assert.deepEqual(resolved, [undefined, "/repo"], "a repeated request skips resolution");
  assert.deepEqual(await manager.ensure("/other"), { ok: true, url: "http://127.0.0.1:4040/#token", summary: "ready" });
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
    const manager = createBrokerManager(
      {
        spawn: () => {
          queueMicrotask(() => current.stdout.emit(receipt));
          return current.handle;
        },
      },
      { getParentOrigin: () => "dsh-app://app", resolveWorkspace: async () => "/repo" },
    );
    const result = await manager.ensure();
    assert.deepEqual(result, JSON.parse(receipt));
    assert.equal(current.terminated.value, true);
  }
});

test("broker preserves the CLI top-level daemon failure code and diagnostic hint", async () => {
  const current = child();
  const manager = createBrokerManager(
    {
      spawn: () => {
        queueMicrotask(() =>
          current.stdout.emit(
            '{"ok":false,"code":"daemon_start_failed","diagnostic":{"expectation":"Start the local daemon, then retry ha gui."}}\n',
          ),
        );
        return current.handle;
      },
    },
    { getParentOrigin: () => "dsh-app://app", resolveWorkspace: async () => "/repo" },
  );
  assert.deepEqual(await manager.ensure(), {
    ok: false,
    error: { code: "daemon_start_failed", hint: "Start the local daemon, then retry ha gui." },
  });
  assert.equal(current.terminated.value, true);
});

test("disposing while ha is starting terminates the pending child", async () => {
  const current = child();
  const manager = createBrokerManager(
    { spawn: () => current.handle },
    { getParentOrigin: () => "dsh-app://app", resolveWorkspace: async () => "/repo" },
  );
  const pending = manager.ensure();
  await settle();
  await manager.dispose();
  assert.equal(current.terminated.value, true);
  assert.deepEqual(await pending, {
    ok: false,
    error: { code: "broker_superseded", hint: "The workspace changed or the plugin stopped. Open Harness again." },
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
  const routes: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    routes.push(String(input));
    return new Response(JSON.stringify({ ok: true, url: "http://127.0.0.1:4321/" }), { status: 200 });
  };
  const icon = iconRegistration.component({ size: 16, active: false } as never) as {
    readonly props: { readonly onClick?: () => Promise<void> };
  };
  assert.equal(icon.props.onClick, undefined, "the sidebar entry only selects the tutorial panel");
  await openHarnessBrowser(ctx, fetcher);
  assert.deepEqual(selectedPanels, [null]);
  assert.deepEqual(clicks, [{ kind: "browser", url: "http://127.0.0.1:4321/" }]);
  assert.deepEqual(routes, ["/__harness_anything/broker?workspace=%2Fselected"], "the main view's Workspace is sent");
});

test("client displays broker code and hint in the shell overlay on failure", async () => {
  const harness = clientHarness();
  const { ctx, registrations, injections } = harness;
  applyClient(ctx as never);
  const mainRegistration = registrations.find((entry) => entry.options.name === "main");
  assert.ok(mainRegistration);
  const tutorial = mainRegistration.component({} as never) as {
    readonly props: { readonly onOpenBeside: () => void };
  };
  const openButton = { props: { onClick: tutorial.props.onOpenBeside } };
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

test("client propagates unexpected browser errors without retrying", async () => {
  const harness = clientHarness();
  const failure = new Error("browser plugin unavailable");
  let attempts = 0;
  const ctx = {
    ...harness.ctx,
    sidebarRight: {
      openTab: () => {
        attempts += 1;
        throw failure;
      },
    },
  } as never;
  const fetcher: typeof fetch = async () =>
    new Response(JSON.stringify({ ok: true, url: "http://127.0.0.1:4321/" }), { status: 200 });
  await assert.rejects(openHarnessBrowser(ctx, fetcher), (error: unknown) => error === failure);
  assert.equal(attempts, 1);
});

test("broker coalesces concurrent requests, retries failures, and replaces an exited process", async () => {
  const children: Child[] = [];
  const manager = createBrokerManager(
    {
      spawn() {
        const next = child();
        children.push(next);
        return next.handle;
      },
    },
    {
      resolveWorkspace: async () => "/repo",
      getParentOrigin: () => "http://127.0.0.1:4000",
    },
  );
  const first = manager.ensure();
  const concurrent = manager.ensure();
  await settle();
  assert.equal(children.length, 1);
  children[0]!.stdout.emit(JSON.stringify({ ok: false, error: { code: "invalid_field", hint: "Upgrade CLI." } }));
  assert.deepEqual(await first, await concurrent);
  const retry = manager.ensure();
  await settle();
  assert.equal(children.length, 2);
  children[1]!.stdout.emit(JSON.stringify({ ok: true, url: "http://127.0.0.1:4001/" }));
  assert.equal((await retry).ok, true);
  children[1]!.resolve({ exitCode: 0, signal: null });
  await children[1]!.handle.done;
  const replacement = manager.ensure();
  await settle();
  assert.equal(children.length, 3);
  children[2]!.stdout.emit(JSON.stringify({ ok: true, url: "http://127.0.0.1:4002/" }));
  assert.deepEqual(await replacement, { ok: true, url: "http://127.0.0.1:4002/" });
  await manager.dispose();
});

test("broker never returns a stale workspace URL to an in-flight request", async () => {
  const children: Child[] = [];
  const manager = createBrokerManager(
    {
      spawn() {
        const next = child();
        children.push(next);
        return next.handle;
      },
    },
    {
      resolveWorkspace: async (requested) => requested ?? "/first",
      getParentOrigin: () => "dsh-app://app",
    },
  );
  const pending = manager.ensure("/first");
  await settle();
  const replacement = manager.ensure("/second");
  await settle();
  children[0]!.stdout.emit(JSON.stringify({ ok: true, url: "http://127.0.0.1:4001/" }));
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "broker_superseded");
  assert.equal(children[0]!.terminated.value, true);
  children[1]!.stdout.emit(JSON.stringify({ ok: true, url: "http://127.0.0.1:4002/" }));
  assert.deepEqual(await replacement, { ok: true, url: "http://127.0.0.1:4002/" });
  await manager.dispose();
});

test("board follows the selected Workspace, then any served Workspace, then the daemon's latest repository", () => {
  const repos = [{ rootDir: "/latest" }, { rootDir: "/repo" }];
  const choose = (requested: string | undefined, workspaces: readonly string[], served = repos) =>
    chooseWorkspace({ requested, workspaces, repos: served, separator: "/", fallback: "/cwd" });
  assert.equal(choose("/repo/sub", ["/skills", "/repo/sub"]), "/repo/sub", "a selected served Workspace wins");
  assert.equal(choose("/skills", ["/skills", "/repo"]), "/repo", "an unserved selection yields to a served Workspace");
  assert.equal(choose("/skills", ["/skills"]), "/latest", "then the daemon's most recent repository");
  assert.equal(
    choose("/skills", ["/skills"], []),
    "/skills",
    "with nothing served the selection shows ha gui guidance",
  );
  assert.equal(choose("/unlisted", ["/skills"], []), "/skills", "an unlisted request is never used as a root");
  assert.equal(choose(undefined, [], []), "/cwd");
  assert.equal(choose("/repository", ["/repository"]), "/latest", "a sibling path prefix is not inside a repository");
});

test("registered repositories come from ha daemon status, attached and most recent first", async () => {
  const current = child();
  const argv: string[][] = [];
  const pending = readRegisteredRepos(
    {
      spawn(spec) {
        argv.push([...spec.argv]);
        return current.handle;
      },
    },
    "ha",
    "/home",
  );
  current.stdout.emit(
    `${JSON.stringify({
      ok: true,
      repos: [
        { rootDir: "/closed-new", state: "closed", materialization: { lastCheckpointAt: "2026-11-01T10:00:00Z" } },
        { rootDir: "/attached-old", state: "attached", materialization: { lastCheckpointAt: "2026-10-01T00:00:00Z" } },
        { rootDir: "/attached-new", state: "attached", materialization: { lastCheckpointAt: "2026-11-01T09:00:00Z" } },
        { state: "attached" },
      ],
    })}\n`,
  );
  current.resolve({ exitCode: 0, signal: null });
  assert.deepEqual(await pending, [
    { rootDir: "/attached-new" },
    { rootDir: "/attached-old" },
    { rootDir: "/closed-new" },
  ]);
  assert.deepEqual(argv, [["ha", "daemon", "status", "--json"]]);
  const silent = child();
  const none = readRegisteredRepos({ spawn: () => silent.handle }, "ha", "/home");
  silent.resolve({ exitCode: 1, signal: null });
  assert.deepEqual(await none, [], "an unreachable daemon serves nothing");
  assert.deepEqual(
    await readRegisteredRepos(
      {
        spawn() {
          throw new Error("spawn ha ENOENT");
        },
      },
      "ha",
      "/home",
    ),
    [],
  );
});

test("Host obtains embedding origin from its profile and webServer, never request headers", async () => {
  for (const profile of ["desktop", "web"]) {
    let handler!: ReturnType<typeof createBrokerManager>["handle"];
    let dispose!: () => Promise<void>;
    let originReads = 0;
    const argv: string[][] = [];
    applyHost({
      subprocess: {
        spawn(spec: { argv: string[] }) {
          argv.push(spec.argv);
          const next = child();
          const status = spec.argv[1] === "daemon";
          queueMicrotask(() => {
            next.stdout.emit(
              JSON.stringify(
                status
                  ? { ok: true, repos: [{ rootDir: "/repo", state: "attached" }] }
                  : { ok: true, url: "http://127.0.0.1:4001/" },
              ),
            );
            if (status) next.resolve({ exitCode: 0, signal: null });
          });
          return next.handle;
        },
      },
      get: () => ({ name: profile }),
      workspaceRegistry: { list: () => [{ path: "/skills" }, { path: "/repo" }] },
      webServer: {
        getOrigin: () => {
          originReads += 1;
          return "http://127.0.0.1:4000";
        },
        register: (route: { handler: typeof handler }) => {
          handler = route.handler;
          return () => {};
        },
      },
      effect: (factory: () => typeof dispose) => {
        dispose = factory();
      },
      logger: { info() {} },
    } as never);
    assert.equal(originReads, 0, "origin is read only after the Host listener is ready");
    await handler(
      {
        method: "GET",
        url: "/__harness_anything/broker?workspace=%2Fskills",
        headers: { origin: "https://untrusted.example" },
      } as never,
      { setHeader() {}, end() {} } as never,
    );
    assert.deepEqual(argv[0], ["ha", "daemon", "status", "--json"]);
    assert.deepEqual(argv[1], [
      "ha",
      "gui",
      "--browser",
      "--parent-origin",
      profile === "desktop" ? "dsh-app://app" : "http://127.0.0.1:4000",
      "--root",
      "/repo",
      "--json",
    ]);
    assert.equal(originReads, profile === "desktop" ? 0 : 1);
    await dispose();
  }
});
