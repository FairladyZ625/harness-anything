// harness-test-tier: contract
import { randomUUID } from "node:crypto";
import type { IpcMainInvokeEvent } from "electron";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessAdminService } from "../../daemon/src/access-admin-service.ts";
import type { DaemonHost } from "../../daemon/src/daemon-host-types.ts";
import { KeycloakPolicyAdapter } from "../../daemon/src/keycloak-policy-adapter.ts";
import { managedRbacReceiptJournal } from "../../daemon/src/managed-rbac-service.ts";
import { OidcSessionService } from "../../daemon/src/oidc-session-service.ts";
import { createJsonRpcProtocolServer } from "../../daemon/src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../../daemon/src/protocol/version.ts";
import { evaluateRepoCellAction } from "../../daemon/src/repo-cell-authorization.ts";
import type { RepoTaskAction } from "../../daemon/src/repo-cell-types.ts";
import { fakeKeycloak, keycloakRealm, keycloakUrl, keycloakUserRoot } from "../../daemon/test/keycloak.fixtures.ts";
import type { AccessAdminApi } from "../src/api/access-admin-contract.ts";
import type { OidcAuthApi } from "../src/api/oidc-auth-contract.ts";
import { registerAccessAdminIpc } from "../src/main/access-admin-ipc.ts";
import { accessAdminPreloadApi } from "../src/preload/access-admin-preload.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { IdentityAccessView } from "../src/renderer/views/IdentityAccessView.tsx";

// This file loads the daemon's own modules, which Vite only leaves intact in the Node environment
// (the browser one rewrites their `new URL(…, import.meta.url)` asset paths). The DOM is installed by
// hand before React loads; everything Node already provides (URL, fetch, Response) stays Node's.
await vi.hoisted(async () => {
  const { Window } = await import("happy-dom"),
    window = new Window({ url: "http://localhost/" }),
    native = new Set(Object.getOwnPropertyNames(globalThis));
  for (const name of ["Event", "CustomEvent", "EventTarget", "navigator"]) native.delete(name);
  for (const name of Object.getOwnPropertyNames(window))
    if (!native.has(name))
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: window[name as never] });
  Object.assign(globalThis, { window, IS_REACT_ACT_ENVIRONMENT: true });
});

let container: HTMLDivElement, root: Root;

const trusted = { sender: { id: 7 }, senderFrame: { url: "file:///renderer/index.html" } } as IpcMainInvokeEvent,
  trustPolicy = {
    isTrustedWebContentsId: (id: number) => id === 7,
    rendererUrl: { packagedRendererUrl: trusted.senderFrame!.url },
  };

/**
 * Everything between the page and Keycloak is the production code: the preload surface, the main
 * process handler, the daemon's JSON-RPC contract, and the access administration service. Only
 * Keycloak itself is the in-memory realm the daemon's own tests use.
 */
async function stack() {
  const keycloak = fakeKeycloak(),
    user = keycloakUserRoot(),
    oidc = new OidcSessionService(user.root, { fetch: keycloak.fetch }),
    admin = new AccessAdminService(oidc, user.root, { fetch: keycloak.fetch }),
    server = createJsonRpcProtocolServer({
      host: { manageRbac: (request: never) => admin.run(request) } as unknown as DaemonHost,
      build: { buildId: "test", commit: null } as never,
      authContext: { transportKind: "unix-socket" },
      emit: async () => undefined,
    });
  await new KeycloakPolicyAdapter(
    { url: keycloakUrl, realm: keycloakRealm, resourceServerClientId: "harness-center" },
    keycloak.fetch,
  ).syncBasePolicy("center-token");
  keycloak.writes.length = 0;
  let requestId = 1;
  await server.handle({
    jsonrpc: "2.0",
    id: requestId,
    method: "protocol.hello",
    params: { protocolVersion: currentDaemonProtocolVersion },
  });
  let handler!: (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>;
  registerAccessAdminIpc({ handle: (_channel, listener) => (handler = listener) }, trustPolicy, {
    daemonRequest: async (params) =>
      (
        (await server.handle({ jsonrpc: "2.0", id: ++requestId, method: "daemon.rbac.manage", params })) as {
          readonly result: never;
        }
      ).result,
    operationId: randomUUID,
  });
  return {
    keycloak,
    ...user,
    journal: managedRbacReceiptJournal(user.root),
    access: accessAdminPreloadApi((_channel, request) => handler(trusted, request)),
    // The production evaluation path: RepoCell → KeycloakPolicyAdapter → UMA decision.
    evaluate: async (personId: string, repoId: string, action: RepoTaskAction) =>
      (
        await evaluateRepoCellAction({
          action,
          binding: {
            actor: { principal: { personId }, executor: null },
            source: "local",
            keycloakAuthorization: {
              session: {
                personId,
                accessToken: `token-${personId}`,
                url: keycloakUrl,
                realm: keycloakRealm,
                clientId: "harness-center",
              },
            },
          },
          actionId: randomUUID(),
          repoId,
          revision: 1,
          now: "2026-10-01T00:00:00.000Z",
          fetchPort: keycloak.fetch,
        })
      ).outcome,
  };
}

const auth: OidcAuthApi = {
  status: vi.fn(async () => ({ ok: true, authenticated: true, personId: "person-admin" })),
  bindingStatus: vi.fn(async () => ({ ok: true, mode: "managed", ready: true, url: keycloakUrl, realm: "harness" })),
  bootstrapStatus: vi.fn(async () => ({ ok: true, required: false })),
  login: vi.fn(async () => ({ ok: true })),
  logout: vi.fn(async () => ({ ok: true })),
  openConsole: vi.fn(async () => ({ ok: true })),
  configure: vi.fn(async () => ({ ok: true })),
  bootstrapAdmin: vi.fn(async () => ({ ok: true })),
};

/** The fake realm answers on `setImmediate`, so a step is settled once the DOM stops changing. */
async function settle() {
  for (let quiet = 0, previous = ""; quiet < 3; ) {
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 15)));
    quiet = container.innerHTML === previous ? quiet + 1 : 0;
    previous = container.innerHTML;
  }
}

const find = <T extends HTMLElement>(selector: string) => {
    const element = container.querySelector<T>(selector);
    if (!element) throw new Error(`Nothing matches ${selector}.`);
    return element;
  },
  byTestId = <T extends HTMLElement = HTMLElement>(id: string) => find<T>(`[data-testid="${id}"]`),
  labelled = (scope: HTMLElement, text: string) => {
    const label = [...scope.querySelectorAll("label")].find((item) => item.textContent?.trim() === text);
    if (!label) throw new Error(`No control is labelled ${text}.`);
    return label.querySelector("input")!;
  };

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await settle();
}

async function type(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

async function openTab(access: AccessAdminApi, name: string) {
  if (!container.firstChild) {
    Object.defineProperty(window, "harness", { configurable: true, value: { auth, access } });
    await act(async () =>
      root.render(createElement(IdentityAccessView, { repos: [{ repoId: "repo-a", displayName: "Repo A" }] })),
    );
    await settle();
  }
  await click([...container.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent === name)!);
}

beforeEach(() => {
  setActiveLocale("zh-CN");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(window, "harness");
});

describe("账号与访问控制页", () => {
  it("creates a custom group, picks an action, inherits a Base group, grants it on a repository, and the account is allowed there only", async () => {
    const { keycloak, access, evaluate, signIn } = await stack();
    keycloak.account("alice");
    expect(await evaluate("alice", "repo-a", { kind: "task-create" })).toBe("denied");

    await openTab(access, "策略组");
    await click(byTestId("access-group-new"));
    await type(byTestId<HTMLInputElement>("access-group-id"), "release");
    await type(byTestId<HTMLInputElement>("access-group-name"), "发布组");
    await click(find('input[data-action="decision-reject"]'));
    await click(labelled(byTestId("access-group-inherits"), "contributor"));
    // Inheriting contributor brings its actions in, checked and not individually removable.
    const inherited = find<HTMLInputElement>('input[data-action="task-create"]');
    expect([inherited.checked, inherited.disabled]).toEqual([true, true]);
    await click(byTestId("access-group-save"));
    expect(byTestId("access-group-list").textContent).toContain("发布组");
    expect(keycloak.roles.get("release")?.attributes?.harness_scopes).toEqual(["decision-reject"]);

    await openTab(access, "人员授权");
    await type(byTestId<HTMLSelectElement>("access-grant-person"), "alice");
    await type(byTestId<HTMLSelectElement>("access-grant-group"), "release");
    await type(byTestId<HTMLInputElement>("access-grant-repo"), "repo-a");
    await click(byTestId("access-grant-submit"));

    // Real decisions for the granted account: allowed by the group's own action and by inheritance, on repository A only.
    expect(await evaluate("alice", "repo-a", { kind: "decision-reject" } as RepoTaskAction)).toBe("allowed");
    expect(await evaluate("alice", "repo-a", { kind: "task-create" })).toBe("allowed");
    expect(await evaluate("alice", "repo-a", { kind: "repo-purge" } as RepoTaskAction)).toBe("denied");
    expect(await evaluate("alice", "repo-b", { kind: "task-create" })).toBe("denied");

    // The page explains the same answer: each allowed action with its source group, the rest as denied.
    const effective = byTestId("access-effective").textContent ?? "";
    expect(effective).toContain("持有 发布组，授于仓库 repo-a");
    // 继承组链不再整串截断:链进 ChainStrip 单行横滚(全文可滚到),aria-label 带完整链。
    const inheritChain = byTestId("inherit-chain");
    expect(inheritChain.getAttribute("aria-label")).toBe("继承展开 release → contributor → viewer");
    expect(inheritChain.textContent).toBe("release → contributor → viewer");
    expect(inheritChain.className).toContain("overflow-x-auto");
    expect(inheritChain.querySelector("span")!.className).toContain("whitespace-nowrap");
    expect(byTestId("access-source-release").textContent).toMatch(/允许 1 个动作来自 发布组.*decision-reject$/u);
    const inheritedSource = byTestId("access-source-contributor").textContent ?? "";
    expect(inheritedSource).toContain("来自 contributor（经 发布组 授于仓库 repo-a）");
    expect(inheritedSource).toContain("task-create");
    expect(inheritedSource).not.toContain("decision-reject");
    expect(byTestId("access-denied").textContent).toContain("repo-purge");
    expect(byTestId("access-denied").textContent).not.toContain("task-create");
    expect(byTestId("access-effective-receipts").textContent).toContain("授予策略组");
    expect(byTestId("access-grant-list").textContent).toContain("alice");

    // Switching to the granted account: it is not an access administrator, so the daemon refuses its write.
    const writes = keycloak.writes.length;
    signIn("alice", []);
    await click(find('[data-testid^="access-revoke-"]'));
    expect(byTestId("access-grant-refusal").dataset.code).toBe("authorization_denied");
    expect(keycloak.writes.length).toBe(writes);
    expect(await evaluate("alice", "repo-a", { kind: "task-create" })).toBe("allowed");
    await openTab(access, "策略组");
    expect(byTestId("access-groups-unavailable").textContent).toContain("不是访问管理员");
  });

  it("shows a Base group with every editing control disabled, and the daemon refuses the same write", async () => {
    const { keycloak, access } = await stack();
    await openTab(access, "策略组");
    await click(
      [...byTestId("access-group-list").querySelectorAll<HTMLElement>("[data-dense-row]")].find((row) =>
        row.textContent?.startsWith("maintainer"),
      )!,
    );
    const editor = byTestId("access-group-editor"),
      controls = [...editor.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")].filter(
        // The facet switch only changes how the list is grouped.
        (control) => control.closest('[data-testid="access-action-picker"] > div:first-child') === null,
      );
    expect(controls.length).toBeGreaterThan(100);
    expect(controls.filter((control) => !control.disabled).map((control) => control.outerHTML)).toEqual([]);
    expect(byTestId("access-group-base-rule").textContent).toContain("继承 contributor");

    const group = await access.groups(),
      maintainer = group.ok ? group.groups.find((item) => item.id === "maintainer")! : null,
      refused = await access.updateGroup({
        groupId: "maintainer",
        displayName: "maintainer",
        scopes: [],
        composites: [],
        expectedVersion: maintainer!.version,
      });
    expect([refused.ok, refused.ok ? null : refused.code]).toEqual([false, "base_policy_group_read_only"]);
    expect(keycloak.writes).toEqual([]);

    // Negative control: the same editor on a custom group is editable.
    await click(byTestId("access-group-new"));
    expect(byTestId<HTMLInputElement>("access-group-id").disabled).toBe(false);
    expect(find<HTMLInputElement>('input[data-action="task-create"]').disabled).toBe(false);
  });

  it("shows a structured conflict when another administrator changed the group first, and writes nothing", async () => {
    const { keycloak, access } = await stack();
    await access.createGroup({ groupId: "release", displayName: "发布组", scopes: ["task-create"], composites: [] });
    await openTab(access, "策略组");
    await click(
      [...byTestId("access-group-list").querySelectorAll<HTMLElement>("[data-dense-row]")].find((row) =>
        row.textContent?.startsWith("发布组"),
      )!,
    );

    // A second administrator, from another window, saves against the same version first.
    const listed = await access.groups(),
      read = listed.ok ? listed.groups.find((group) => group.id === "release")! : null,
      first = await access.updateGroup({
        groupId: "release",
        displayName: "发布组",
        scopes: ["decision-review"],
        composites: [],
        expectedVersion: read!.version,
      });
    expect(first.ok).toBe(true);
    const stored = () => keycloak.roles.get("release")?.attributes?.harness_scopes;
    expect(stored()).toEqual(["decision-review"]);

    await click(find('input[data-action="decision-reject"]'));
    await click(byTestId("access-group-save"));
    const conflict = byTestId("access-group-conflict").textContent ?? "";
    expect(conflict).toContain("已被其他管理员改过");
    expect(conflict).toContain(read!.version.slice(0, 8));
    expect(stored()).toEqual(["decision-review"]);

    // Loading the latest version shows the other administrator's change; the retry is made against it and lands.
    await click(byTestId("access-group-load-latest"));
    expect(container.querySelector('[data-testid="access-group-conflict"]')).toBeNull();
    expect(find<HTMLInputElement>('input[data-action="decision-review"]').checked).toBe(true);
    expect(find<HTMLInputElement>('input[data-action="task-create"]').checked).toBe(false);
    await click(find('input[data-action="decision-reject"]'));
    await click(byTestId("access-group-save"));
    expect(stored()).toEqual(["decision-reject", "decision-review"]);
  });

  it("lists audit receipts and reconciles an operation that has no settled receipt without repeating it", async () => {
    const { keycloak, access, journal } = await stack();
    await access.createGroup({ groupId: "release", displayName: "发布组", scopes: [], composites: [] });
    // The write reached Keycloak; the settled receipt was lost.
    const settled = journal.read().at(-1)!;
    journal.append(
      JSON.stringify({ ...JSON.parse(settled), operationId: "lost-receipt", phase: "intent", outcome: undefined }),
    );
    keycloak.writes.length = 0;

    await openTab(access, "审计回执");
    const receipts = () => byTestId("access-receipts").textContent ?? "";
    expect(receipts()).toContain("未结算");
    expect(receipts()).toContain("新建策略组: release");
    await click(byTestId("receipt-reconcile-lost-receipt"));
    expect(receipts()).not.toContain("未结算");
    expect(container.querySelector('[data-testid="receipt-reconcile-lost-receipt"]')).toBeNull();
    expect(keycloak.writes).toEqual([]);
  });

  it("names the Keycloak that carries authorization, opens its console outside the page, and sets the session lifetime", async () => {
    const { keycloak, access } = await stack();
    await openTab(access, "授权服务");
    const card = byTestId("access-service-card").textContent ?? "";
    for (const shown of ["授权服务 · Keycloak", "Harness 托管", keycloakUrl, keycloakRealm, "正常"])
      expect(card).toContain(shown);
    await click(byTestId("access-open-console"));
    expect(auth.openConsole).toHaveBeenCalledTimes(1);
    expect(container.querySelector("iframe, webview")).toBeNull();

    // Keycloak's default idle timeout is half an hour; the change is written to the realm against that value.
    const minutes = byTestId<HTMLInputElement>("access-lifetime-minutes");
    expect(minutes.value).toBe("30");
    await type(minutes, "60");
    await click(byTestId("access-lifetime-save"));
    expect(keycloak.realm.ssoSessionIdleTimeout).toBe(3_600);
    expect(byTestId<HTMLInputElement>("access-lifetime-minutes").value).toBe("60");
    await type(byTestId<HTMLInputElement>("access-lifetime-minutes"), "1");
    await click(byTestId("access-lifetime-save"));
    expect(byTestId("access-lifetime-refusal").dataset.code).toBe("session_lifetime_invalid");
    expect(keycloak.realm.ssoSessionIdleTimeout).toBe(3_600);
  });

  it("renders every tab in English without a Chinese string left behind", async () => {
    const { keycloak, access } = await stack();
    keycloak.account("alice");
    await access.grant({ personId: "alice", groupId: "viewer", resource: "repo-a" });
    setActiveLocale("en-US");
    for (const tab of ["Authorization service", "Policy groups", "Grants", "Audit receipts"]) {
      await openTab(access, tab);
      if (tab === "Grants") await click(find('[data-testid="access-grant-list"] [data-dense-row]'));
      expect(container.textContent).not.toMatch(/[\u3400-\u9fff\uff00-\uffef]/u);
    }
    expect(container.textContent).toContain("Grant group: viewer · alice · repository repo-a");
  });
});
