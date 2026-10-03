// harness-test-tier: fast
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OidcAuthApi } from "../src/api/oidc-auth-contract.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { IdentityAccessView } from "../src/renderer/views/IdentityAccessView.tsx";

let container: HTMLDivElement, root: Root;

function auth(overrides: Partial<OidcAuthApi> = {}): OidcAuthApi {
  return {
    status: vi.fn(async () => ({ ok: true, authenticated: false })),
    bindingStatus: vi.fn(async () => ({ ok: true, mode: "managed", ready: true })),
    bootstrapStatus: vi.fn(async () => ({ ok: true, required: false })),
    login: vi.fn(async () => ({ ok: true })),
    logout: vi.fn(async () => ({ ok: true })),
    openConsole: vi.fn(async () => ({ ok: true })),
    configure: vi.fn(async () => ({ ok: true })),
    bootstrapAdmin: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

async function render(viewAuth: OidcAuthApi) {
  Object.defineProperty(window, "harness", { configurable: true, value: { auth: viewAuth } });
  await act(async () => root.render(createElement(IdentityAccessView)));
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
    const values = ["https://127.0.0.1:9", "bogus", "ha-gui"];
    form!.querySelectorAll("input").forEach((input, index) => {
      Object.defineProperty(input, "value", { configurable: true, value: values[index] });
    });
    await act(async () => form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("bootstrap_failed: fetch failed");
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
});
