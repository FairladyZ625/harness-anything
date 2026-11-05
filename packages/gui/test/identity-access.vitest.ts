// harness-test-tier: fast
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OidcAuthApi } from "@harness-anything/authorization-gui/oidc-auth-contract";
import { identityProviderOf } from "@harness-anything/authorization-gui/identity-presentation";
import type { AuthorizationUiComponents } from "@harness-anything/authorization-gui/ui-component-contract";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { IdentityAccessView } from "../src/renderer/views/IdentityAccessView.tsx";
import { requestAccountLogin, resetAccountLoginRequestForTest } from "../src/renderer/account-login-request.ts";

let container: HTMLDivElement, root: Root;

function auth(overrides: Partial<OidcAuthApi> = {}): OidcAuthApi {
  return {
    status: vi.fn(async () => ({ ok: true, authenticated: false })),
    bindingStatus: vi.fn(async () => ({ ok: true, mode: "managed", ready: true })),
    bootstrapStatus: vi.fn(async () => ({ ok: true, required: false })),
    cancelLogin: vi.fn(async () => ({ ok: true })),
    login: vi.fn(async () => ({ ok: true })),
    logout: vi.fn(async () => ({ ok: true })),
    openConsole: vi.fn(async () => ({ ok: true })),
    configure: vi.fn(async () => ({ ok: true })),
    bootstrapAdmin: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

async function render(viewAuth: OidcAuthApi, components?: AuthorizationUiComponents) {
  Object.defineProperty(window, "harness", { configurable: true, value: { auth: viewAuth } });
  await act(async () => root.render(createElement(IdentityAccessView, { components })));
  await act(async () => undefined);
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
  resetAccountLoginRequestForTest();
});

describe("IdentityAccessView", () => {
  it("shows a center binding without offering local configuration to an edge user", async () => {
    await render(
      auth({
        status: vi.fn(async () => ({ authenticated: true, personId: "ordinary-person" })),
        bindingStatus: vi.fn(async () => ({
          source: "fleet-center",
          mode: "external",
          ready: true,
          url: "https://center.example",
          realm: "harness",
        })),
      }),
    );
    expect(container.textContent).toContain("ordinary-person");
    expect(container.textContent).toContain("https://center.example");
    expect(container.textContent).not.toContain("尚未绑定 Keycloak");
    expect(container.querySelector('[data-testid="external-binding-form"]')).toBeNull();
  });

  it("shows discovery failure without offering configuration or claiming an unbound state", async () => {
    await render(
      auth({
        bindingStatus: vi.fn(async () => {
          throw new Error("ECONNREFUSED: center unavailable");
        }),
      }),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("center unavailable");
    expect(container.textContent).not.toContain("尚未绑定 Keycloak");
    expect(container.querySelector('[data-testid="external-binding-form"]')).toBeNull();
  });

  it("shows daemon rejection details when external configuration is rejected", async () => {
    await render(
      auth({
        configure: vi.fn(async () => {
          throw Object.assign(new Error("bootstrap_failed: fetch failed"), { code: "bootstrap_failed" });
        }),
      }),
    );
    const form = container.querySelector("form");
    expect(form).not.toBeNull();
    const values = ["https://127.0.0.1:9", "bogus", "harness-center", "fixture-secret"];
    form!.querySelectorAll("input").forEach((input, index) => {
      input.value = values[index]!;
    });
    await act(async () => form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("bootstrap_failed: fetch failed");
  });

  it.each([false, true])("external secret is cleared on submit, including refusal=%s", async (reject) => {
    let configured = false;
    const configure = vi.fn(async () => {
      expect(container.querySelector<HTMLInputElement>('input[name="clientSecret"]')!.value).toBe("");
      if (reject) throw new Error("Credentials rejected");
      configured = true;
      return { ok: true };
    });
    await render(
      auth({
        configure,
        bindingStatus: vi.fn(async () => (configured ? { mode: "external", ready: true } : { configured: false })),
        bootstrapStatus: vi.fn(async () => ({ required: true })),
      }),
    );
    const form = container.querySelector<HTMLFormElement>('[data-testid="external-binding-form"]')!;
    form.querySelector<HTMLInputElement>('[name="url"]')!.value = "https://identity.example.test";
    form.querySelector<HTMLInputElement>('[name="realm"]')!.value = "fleet";
    const secret = form.querySelector<HTMLInputElement>('[name="clientSecret"]')!;
    expect(secret.type).toBe("password");
    secret.value = "fixture-write-only";
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(configure).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "harness-center", clientSecret: "fixture-write-only" }),
      undefined,
      undefined,
    );
    expect(secret.value).toBe("");
    expect(container.textContent).not.toContain("fixture-write-only");
    expect(Boolean(container.querySelector('[data-testid="bootstrap-admin-form"]'))).toBe(!reject);
  });

  it("renders an unbound state and disables login when Keycloak is not configured", async () => {
    await render(
      auth({
        bindingStatus: vi.fn(async () => ({ ok: true, configured: false })),
      }),
    );
    expect(container.textContent).toContain("尚未绑定 Keycloak");
    const login = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("登录"));
    expect(login?.disabled).toBe(true);
  });

  it("renders the complete identity surface in English", async () => {
    setActiveLocale("en-US");
    await render(auth());
    expect(container.textContent).toContain("Identity & access");
    expect(container.textContent).toContain("Sign in with Keycloak");
    expect(container.textContent).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it("uses host-provided identity and login components", async () => {
    const UserIdentity: NonNullable<AuthorizationUiComponents["UserIdentity"]> = ({ personId }) =>
        createElement("output", { "data-testid": "host-user" }, personId),
      Login: NonNullable<AuthorizationUiComponents["Login"]> = () =>
        createElement("output", { "data-testid": "host-login" }, "Studio login");
    await render(auth({ status: vi.fn(async () => ({ authenticated: true, personId: "studio-person" })) }), {
      UserIdentity,
      Login,
    });
    expect(container.querySelector('[data-testid="host-user"]')?.textContent).toBe("studio-person");
    expect(container.querySelector('[data-testid="host-login"]')?.textContent).toBe("Studio login");
    expect(container.querySelector('[data-testid="external-binding-form"]')).toBeNull();
  });

  it("does not claim Keycloak while the identity binding is still unresolved", async () => {
    let resolveBinding!: (value: unknown) => void;
    await render(
      auth({
        bindingStatus: vi.fn(
          () =>
            new Promise((resolve) => {
              resolveBinding = resolve;
            }),
        ),
      }),
    );
    expect(container.textContent).not.toContain("Keycloak");
    await act(async () => resolveBinding({ ok: true, ready: true, mode: "builtin" }));
    await act(async () => undefined);
    expect(container.textContent).toContain("使用本机账号登录");
    expect(container.textContent).not.toContain("使用 Keycloak 登录");
  });

  it("does not claim Keycloak when the identity binding read fails", async () => {
    await render(
      auth({
        bindingStatus: vi.fn(async () => {
          throw new Error("daemon unavailable");
        }),
      }),
    );
    expect(container.textContent).not.toContain("Keycloak");
  });

  it("invalidates the previous account when a later identity read fails", async () => {
    let fail = false;
    const status = vi.fn(async () => {
      if (fail) throw new Error("session unavailable");
      return { ok: true, authenticated: true, personId: "person-a" };
    });
    Object.defineProperty(window, "harness", {
      configurable: true,
      value: { auth: auth({ status }) },
    });
    await act(async () => root.render(createElement(IdentityAccessView, { repoId: "repo-a" })));
    await act(async () => undefined);
    expect(container.textContent).toContain("person-a");
    fail = true;
    await act(async () => root.render(createElement(IdentityAccessView, { repoId: "repo-b" })));
    await act(async () => undefined);
    expect(container.textContent).not.toContain("person-a");
    expect(container.textContent).toContain("身份不可用");
    expect(container.textContent).not.toContain("尚未登录");
  });

  it("ignores an identity read that resolves after its repository was replaced", async () => {
    const pending: Array<(value: unknown) => void> = [];
    const status = vi.fn((repoId?: string) => {
      if (repoId === "repo-a") return new Promise((resolve) => pending.push(resolve));
      return Promise.reject(new Error("repo-b unavailable"));
    });
    Object.defineProperty(window, "harness", {
      configurable: true,
      value: { auth: auth({ status }) },
    });
    await act(async () => root.render(createElement(IdentityAccessView, { repoId: "repo-a" })));
    await act(async () => undefined);
    expect(pending).toHaveLength(2);
    await act(async () => root.render(createElement(IdentityAccessView, { repoId: "repo-b" })));
    await act(async () => undefined);
    expect(container.textContent).toContain("身份不可用");
    await act(async () => {
      for (const resolve of pending) resolve({ ok: true, authenticated: true, personId: "person-a" });
    });
    await act(async () => undefined);
    expect(container.textContent).not.toContain("person-a");
    expect(container.textContent).toContain("身份不可用");
  });

  it("lands a signed-out account on the service tab and starts the shared login from the header", async () => {
    let finish!: () => void;
    const api = auth({
      status: vi.fn(async () => ({ ok: true, authenticated: false })),
      login: vi.fn((_repoId, openBrowser) => {
        openBrowser({ url: "https://identity.example.test/auth" });
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      }),
      cancelLogin: vi.fn(async () => finish()),
    });
    Object.defineProperty(window, "harness", {
      configurable: true,
      value: { auth: api, access: { forRepository: () => ({}) } },
    });
    await act(async () => root.render(createElement(IdentityAccessView)));
    await act(async () => undefined);
    const selected = container.querySelector('[role="tab"][aria-selected="true"]');
    expect(selected?.textContent).toContain("服务与会话");
    expect(container.querySelector('[data-testid="access-current-provider"]')?.textContent).toContain("Keycloak");
    const header = container.querySelector<HTMLButtonElement>('[data-testid="account-header-sign-in"]')!;
    expect(header).not.toBeNull();
    await act(async () => header.click());
    expect(api.login).toHaveBeenCalledOnce();
    expect(container.querySelector("webview")?.getAttribute("src")).toBe("https://identity.example.test/auth");
    await act(async () => finish());
  });

  it("honours a business-read sign-in request when the account page arrives", async () => {
    const api = auth({ status: vi.fn(async () => ({ ok: true, authenticated: false })) });
    requestAccountLogin();
    await render(api);
    await act(async () => undefined);
    expect(api.login).toHaveBeenCalledOnce();
  });

  it("reports an unreadable identity service without claiming signed out or offering sign-in", async () => {
    await render(
      auth({
        status: vi.fn(async () => {
          throw new Error("identity service down");
        }),
        bindingStatus: vi.fn(async () => ({ ok: true, mode: "managed", ready: true })),
      }),
    );
    expect(container.textContent).toContain("身份不可用");
    expect(container.textContent).toContain("身份服务暂时不可用");
    expect(container.textContent).not.toContain("尚未登录");
    expect(container.querySelector('[data-testid="account-header-sign-in"]')).toBeNull();
    expect(container.querySelector('[data-testid="access-current-provider"]')?.textContent).toContain("Keycloak");
  });
});

it("classifies a binding mode as builtin, Keycloak, or unknown", () => {
  expect(identityProviderOf("builtin")).toBe("builtin");
  expect(identityProviderOf("managed")).toBe("keycloak");
  expect(identityProviderOf("external")).toBe("keycloak");
  expect(identityProviderOf(undefined)).toBe("unknown");
  expect(identityProviderOf("unexpected")).toBe("unknown");
});

it("embeds the authorization URL, cancels cleanly and refreshes identity after a retry", async () => {
  let finish!: () => void,
    reject!: (error: Error) => void,
    signedIn = false;
  const api = auth({
    status: vi.fn(async () => ({ authenticated: signedIn, personId: signedIn ? "person-fixture" : undefined })),
    login: vi.fn((_repoId, openBrowser) => {
      openBrowser({ url: "https://identity.example.test/auth" });
      return new Promise<void>((resolve, rejectLogin) => {
        finish = () => {
          signedIn = true;
          resolve();
        };
        reject = rejectLogin;
      });
    }),
    cancelLogin: vi.fn(async () => {
      reject(new Error("Sign-in cancelled."));
    }),
  });
  await render(api);
  const click = async (id: string) =>
    act(async () => container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.click());
  await click("account-session-action");
  expect(container.querySelector("webview")?.getAttribute("src")).toBe("https://identity.example.test/auth");
  expect(container.querySelector("webview")?.getAttribute("partition")).toBe("in-app-browser");
  await click("account-login-cancel");
  expect(container.querySelector("webview")).toBeNull();
  expect(container.textContent).toContain("Sign-in cancelled.");
  await click("account-session-action");
  await act(async () => finish());
  expect(container.querySelector("webview")).toBeNull();
  expect(container.textContent).toContain("person-fixture");
  expect(container.querySelector('[data-testid="access-current-account"]')?.textContent).toContain("person-fixture");
});

it("keeps the login panel with a readable alert when the authorization page fails to load", async () => {
  let finish!: () => void;
  const api = auth({
    status: vi.fn(async () => ({ authenticated: false })),
    login: vi.fn((_repoId, openBrowser) => {
      openBrowser({
        url: "https://10.211.55.2:18544/realms/harness/protocol/openid-connect/auth",
        partitionToken: "grant-token-fixture",
      });
      return new Promise<void>((resolve) => {
        finish = () => resolve();
      });
    }),
    cancelLogin: vi.fn(async () => {
      finish();
    }),
  });
  await render(api);
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="account-session-action"]')!.click());
  const webview = () => container.querySelector("webview");
  expect(webview()).not.toBeNull();
  // The listener-backed sign-in carries only the opaque grant token; the main process swaps it
  // for the isolated partition when the webview attaches.
  expect(webview()?.getAttribute("partition")).toBe("grant-token-fixture");
  // What Electron reports for an untrusted self-signed certificate, minus the port-bearing origin.
  await act(async () =>
    webview()!.dispatchEvent(
      Object.assign(new Event("did-fail-load"), {
        errorCode: -202,
        errorDescription: "net::ERR_CERT_AUTHORITY_INVALID",
        validatedURL: "https://10.211.55.2:18544/realms/harness/",
      }),
    ),
  );
  expect(webview()).not.toBeNull();
  const alert = container.querySelector('[data-testid="account-login-error"]');
  expect(alert?.getAttribute("role")).toBe("alert");
  expect(alert?.textContent).toContain("net::ERR_CERT_AUTHORITY_INVALID");
  expect(api.cancelLogin).not.toHaveBeenCalled();
  await act(async () => webview()!.dispatchEvent(new Event("did-start-loading")));
  expect(container.querySelector('[data-testid="account-login-error"]')).toBeNull();
  expect(webview()).not.toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="account-login-cancel"]')!.click());
  await act(async () => finish());
  expect(api.cancelLogin).toHaveBeenCalledOnce();
});

it("leaving the account surface cancels its active login", async () => {
  let reject!: (error: Error) => void;
  const api = auth({
    login: vi.fn((_repoId, openBrowser) => {
      openBrowser({ url: "https://identity.example.test/auth" });
      return new Promise((_resolve, rejectLogin) => {
        reject = rejectLogin;
      });
    }),
    cancelLogin: vi.fn(async () => {
      reject(new Error("Sign-in cancelled."));
    }),
  });
  await render(api);
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="account-session-action"]')!.click());
  await act(async () => root.render(null));
  expect(api.cancelLogin).toHaveBeenCalledOnce();
});

describe("device login requests", () => {
  it("shows two nodes separately and opens approval for the selected code", async () => {
    const requests = ["node-one", "node-two"].map((nodeId, index) => ({
      nodeId,
      userCode: index ? "CCCC-DDDD" : "AAAA-BBBB",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    }));
    const login = vi.fn(async () => ({ ok: true }));
    await render(
      auth({
        status: vi.fn(async () => ({ authenticated: true, personId: "owner", deviceLoginRequests: requests })),
        login,
      }),
    );
    expect(container.querySelector('[data-testid="device-login-node-one"]')?.textContent).toContain("node-one");
    expect(container.querySelector('[data-testid="device-login-node-two"]')?.textContent).toContain("node-two");
    expect(container.textContent).toContain("AAAA-BBBB");
    expect(container.textContent).toContain("CCCC-DDDD");
    await act(async () =>
      (container.querySelector('[data-testid="device-approve-node-two"]') as HTMLButtonElement).click(),
    );
    expect(login).toHaveBeenCalledWith(undefined, expect.any(Function), "CCCC-DDDD", undefined);
  });
});

describe("device identity modes", () => {
  it.each(["zh-CN", "en-US"] as const)(
    "explains the single local device without requesting collaboration in %s",
    async (locale) => {
      setActiveLocale(locale);
      const api = auth({ bindingStatus: vi.fn(async () => ({ ok: true, mode: "builtin", ready: true })) }),
        devices = vi.fn(async () => ({ ok: true, nodes: [], version: "v1" }));
      Object.defineProperty(window, "harness", {
        configurable: true,
        value: {
          auth: api,
          access: { forRepository: () => ({ devices }) },
        },
      });
      await act(async () => root.render(createElement(IdentityAccessView)));
      const tab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
        (tab) => tab.textContent === (locale === "zh-CN" ? "我的设备" : "My devices"),
      );
      await act(async () => tab!.click());
      expect(container.querySelector('[data-testid="devices-local-mode"]')?.textContent).toContain(
        locale === "zh-CN" ? "本机就是唯一设备" : "only device",
      );
      expect(container.textContent).toContain(
        locale === "zh-CN" ? "需要多设备协作时" : "when you need multiple devices",
      );
      expect(container.querySelector('[data-testid="devices-security-boundary"]')).toBeNull();
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(devices).not.toHaveBeenCalled();
      expect(api.bindingStatus).toHaveBeenCalledWith(undefined, undefined);
    },
  );

  it("retains the Keycloak device view and its security boundary", async () => {
    const devices = vi.fn(async () => ({ ok: true, nodes: [], version: "v1" }));
    Object.defineProperty(window, "harness", {
      configurable: true,
      value: {
        auth: auth(),
        access: { forRepository: () => ({ devices }) },
      },
    });
    await act(async () => root.render(createElement(IdentityAccessView)));
    const tab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (tab) => tab.textContent === "我的设备",
    );
    await act(async () => tab!.click());
    expect(container.querySelector('[data-testid="devices-security-boundary"]')?.textContent).toContain("Keycloak");
    expect(container.querySelector('[data-testid="devices-empty"]')).not.toBeNull();
    expect(devices).toHaveBeenCalledOnce();
  });
});

it("adds my device through the shared create operation, displays its token-free link, and clears a refusal", async () => {
  const issueEdgeJoin = vi.fn(async () => ({
    ok: true,
    joinId: "member-link",
    state: "pending",
    expiresAt: "2026-11-06T00:00:00Z",
    link: "harness-edge://join/member-device",
  }));
  Object.defineProperty(window, "harness", {
    configurable: true,
    value: {
      auth: auth(),
      access: {
        forRepository: () => ({ issueEdgeJoin, devices: async () => ({ ok: true, nodes: [], version: "v1" }) }),
      },
    },
  });
  await act(async () => root.render(createElement(IdentityAccessView, { repoId: "repo-a" })));
  const tab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (tab) => tab.textContent === "我的设备",
  );
  await act(async () => tab!.click());
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="devices-add"]')!.click());
  expect(issueEdgeJoin).toHaveBeenCalledWith({ joinMode: "member-device", repoIds: ["repo-a"] });
  expect(container.querySelector<HTMLTextAreaElement>('[data-testid="devices-add-link"] textarea')!.value).toBe(
    "harness-edge://join/member-device",
  );
  const writeText = vi.fn(async () => {});
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  try {
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="devices-add-copy"]')!.click());
    expect(writeText).toHaveBeenCalledWith("harness-edge://join/member-device");
    expect(container.querySelector('[data-testid="devices-add-copy"]')!.textContent).toBe("链接已复制");
  } finally {
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="devices-add-dismiss"]')!.click());
  expect(container.querySelector('[data-testid="devices-add-link"]')).toBeNull();
  issueEdgeJoin.mockImplementationOnce(async () => ({ ok: false, code: "authorization_denied" }) as never);
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="devices-add"]')!.click());
  expect(container.querySelector('[data-testid="devices-add-link"]')).toBeNull();
  expect(container.querySelector('[data-testid="device-refusal"]')).not.toBeNull();
});
