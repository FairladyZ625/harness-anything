// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { RepositoryReadNotice } from "../src/renderer/components/RepositoryReadNotice.tsx";

let container: HTMLDivElement, root: Root, client: QueryClient;

function Probe({ fail, onLogin }: { readonly fail: { current: boolean }; readonly onLogin: () => void }) {
  const { data } = useQuery({
    queryKey: ["repo-a", "tasks"],
    queryFn: async () => {
      if (fail.current)
        throw Object.assign(new Error("authentication_required: raw daemon text"), {
          code: "authentication_required",
        });
      return "rows";
    },
    retry: false,
  });
  return (
    <>
      <RepositoryReadNotice repoId="repo-a" onLogin={onLogin} />
      <output data-testid="probe-data">{String(data)}</output>
    </>
  );
}

async function mount(fail: { current: boolean }, onLogin: () => void) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Probe fail={fail} onLogin={onLogin} />
      </QueryClientProvider>,
    ),
  );
}

beforeEach(() => {
  setActiveLocale("zh-CN");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  Reflect.deleteProperty(window, "harness");
});

describe("RepositoryReadNotice", () => {
  it("turns an authentication_required read into a sign-in action instead of raw daemon text", async () => {
    const fail = { current: true },
      onLogin = vi.fn();
    await mount(fail, onLogin);
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="repository-read-state"]')?.getAttribute("data-state")).toBe(
        "authentication-required",
      ),
    );
    expect(container.textContent).toContain("会话已结束或无法再用当前凭据读取台账");
    expect(container.textContent).not.toContain("authentication_required");
    const action = container.querySelector<HTMLButtonElement>('[data-testid="repository-read-sign-in"]')!;
    expect(action.textContent).toBe("登录");
    await act(async () => action.click());
    expect(onLogin).toHaveBeenCalledOnce();
  });

  it("keeps the sign-in action when another mounted read reports a replica failure", async () => {
    function FailedRead({ id, code }: { readonly id: string; readonly code: string }) {
      useQuery({
        queryKey: ["repo-a", id],
        queryFn: async () => {
          throw Object.assign(new Error(code), { code });
        },
        retry: false,
      });
      return null;
    }
    const onLogin = vi.fn();
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <FailedRead id="tasks" code="authentication_required" />
          <FailedRead id="workspace" code="replica_unavailable" />
          <RepositoryReadNotice repoId="repo-a" onLogin={onLogin} />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="repository-read-state"]')?.getAttribute("data-state")).toBe(
        "authentication-required",
      ),
    );
    expect(container.querySelector('[data-testid="repository-read-sign-in"]')).not.toBeNull();
    expect(container.textContent).toContain("会话已结束或无法再用当前凭据读取台账");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="repository-read-sign-in"]')!.click(),
    );
    expect(onLogin).toHaveBeenCalledOnce();
  });

  it("retries the authentication_required reads after the account is signed in again", async () => {
    const fail = { current: true };
    await mount(fail, () => {});
    await vi.waitFor(() => expect(container.querySelector('[data-testid="repository-read-state"]')).not.toBeNull());
    fail.current = false;
    await act(async () => window.dispatchEvent(new Event("harness-auth-signed-in")));
    await vi.waitFor(() => expect(container.querySelector('[data-testid="probe-data"]')?.textContent).toBe("rows"));
    expect(container.querySelector('[data-testid="repository-read-notice"]')).toBeNull();
  });
});
