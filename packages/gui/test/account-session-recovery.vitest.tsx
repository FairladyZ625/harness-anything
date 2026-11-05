// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OidcAuthApi } from "@harness-anything/authorization-gui/oidc-auth-contract";
import { AccessServiceTab } from "../src/renderer/authorization-ui.tsx";
import { RepositoryReadNotice } from "../src/renderer/components/RepositoryReadNotice.tsx";

type PendingStatus = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
};

let container: HTMLDivElement, root: Root, client: QueryClient;

function Probe({ fail }: { readonly fail: { current: boolean } }) {
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
  return <output data-testid="probe-data">{String(data)}</output>;
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function flushUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error("condition did not settle within 20 discrete flushes");
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  vi.useRealTimers();
});

describe("account session recovery", () => {
  it("lets a latest polled session confirmation recover failed reads when login's own read is superseded", async () => {
    const statuses: PendingStatus[] = [],
      status = vi.fn(
        () =>
          new Promise<unknown>((resolve, reject) => {
            statuses.push({ resolve, reject });
          }),
      ),
      bindingStatus = vi.fn(async () => ({ ok: true, mode: "managed", ready: true })),
      // The ancillary bootstrap read fails; it must not swallow the session confirmation.
      bootstrapStatus = vi.fn(async () => {
        throw new Error("bootstrap status unavailable");
      }),
      login = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
    let authenticated = false;
    const auth = {
      status,
      bindingStatus,
      bootstrapStatus,
      login: vi.fn(async () => {
        await login();
        authenticated = true;
      }),
      logout: vi.fn(async () => ({ ok: true })),
      cancelLogin: vi.fn(async () => ({ ok: true })),
      openConsole: vi.fn(async () => ({ ok: true })),
      configure: vi.fn(async () => ({ ok: true })),
      bootstrapAdmin: vi.fn(async () => ({ ok: true })),
    } satisfies OidcAuthApi;
    const signedIn = vi.fn();
    window.addEventListener("harness-auth-signed-in", signedIn);
    const fail = { current: true };
    try {
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <Probe fail={fail} />
            <RepositoryReadNotice repoId="repo-a" />
            <AccessServiceTab auth={auth} access={undefined} repoId="repo-a" rootDir="/repo" />
          </QueryClientProvider>,
        ),
      );
      await flushUntil(() => statuses.length === 1);
      await act(async () => {
        statuses[0]!.resolve({ ok: true, authenticated });
      });
      await flushUntil(() => container.querySelector('[data-testid="account-session-action"]') !== null);
      await flushUntil(() => container.querySelector('[data-testid="repository-read-state"]') !== null);
      expect(container.querySelector('[data-testid="repository-read-state"]')?.getAttribute("data-state")).toBe(
        "authentication-required",
      );

      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="account-session-action"]')!.click();
      });
      await flushUntil(() => container.querySelector('[data-testid="account-login"]') !== null);
      // The login action completes, but its refresh read has not answered yet.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      await flushUntil(() => statuses.length === 2);
      // A periodic status read starts after login and preempts the login confirmation read.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      await flushUntil(() => statuses.length === 3);
      fail.current = false;
      // The newer poll is the read that confirms the session; it must recover the failed query.
      await act(async () => {
        statuses[2]!.resolve({ ok: true, authenticated: true });
      });
      await flushUntil(() => container.querySelector('[data-testid="probe-data"]')?.textContent === "rows");
      // The superseded login read resolves later and must not double-notify or roll state back.
      await act(async () => {
        statuses[1]!.resolve({ ok: true, authenticated: true });
      });
      await flush();
      expect(signedIn).toHaveBeenCalledOnce();
      expect(container.querySelector('[data-testid="repository-read-notice"]')).toBeNull();
    } finally {
      window.removeEventListener("harness-auth-signed-in", signedIn);
    }
  });

  it("recovers when login confirms before the first status read resolves", async () => {
    const statuses: PendingStatus[] = [],
      status = vi.fn(
        () =>
          new Promise<unknown>((resolve, reject) => {
            statuses.push({ resolve, reject });
          }),
      ),
      auth = {
        status,
        bindingStatus: vi.fn(async () => ({ ok: true, mode: "managed", ready: true })),
        bootstrapStatus: vi.fn(async () => ({ ok: true, required: false })),
        login: vi.fn(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }),
        logout: vi.fn(async () => ({ ok: true })),
        cancelLogin: vi.fn(async () => ({ ok: true })),
        openConsole: vi.fn(async () => ({ ok: true })),
        configure: vi.fn(async () => ({ ok: true })),
        bootstrapAdmin: vi.fn(async () => ({ ok: true })),
      } satisfies OidcAuthApi;
    const signedIn = vi.fn(),
      fail = { current: true };
    window.addEventListener("harness-auth-signed-in", signedIn);
    try {
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <Probe fail={fail} />
            <RepositoryReadNotice repoId="repo-a" />
            <AccessServiceTab autoLogin auth={auth} access={undefined} repoId="repo-a" rootDir="/repo" />
          </QueryClientProvider>,
        ),
      );
      await flushUntil(() => statuses.length === 1);
      // The first session read is still pending; login finishes first and its refresh reads true.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      await flushUntil(() => statuses.length === 2);
      fail.current = false;
      await act(async () => {
        statuses[1]!.resolve({ ok: true, authenticated: true });
      });
      await flushUntil(() => container.querySelector('[data-testid="probe-data"]')?.textContent === "rows");
      // The unknown first read resolves later and must not double-notify.
      await act(async () => {
        statuses[0]!.resolve({ ok: true, authenticated: true });
      });
      await flush();
      expect(signedIn).toHaveBeenCalledOnce();
      expect(container.querySelector('[data-testid="repository-read-notice"]')).toBeNull();
    } finally {
      window.removeEventListener("harness-auth-signed-in", signedIn);
    }
  });

  it("recovers when the page still holds a stale authenticated state at re-login", async () => {
    const statuses: PendingStatus[] = [],
      status = vi.fn(
        () =>
          new Promise<unknown>((resolve, reject) => {
            statuses.push({ resolve, reject });
          }),
      ),
      auth = {
        status,
        bindingStatus: vi.fn(async () => ({ ok: true, mode: "managed", ready: true })),
        bootstrapStatus: vi.fn(async () => ({ ok: true, required: false })),
        login: vi.fn(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }),
        logout: vi.fn(async () => ({ ok: true })),
        cancelLogin: vi.fn(async () => ({ ok: true })),
        openConsole: vi.fn(async () => ({ ok: true })),
        configure: vi.fn(async () => ({ ok: true })),
        bootstrapAdmin: vi.fn(async () => ({ ok: true })),
      } satisfies OidcAuthApi;
    const signedIn = vi.fn(),
      fail = { current: true };
    const renderTab = async (autoLogin: boolean) =>
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <Probe fail={fail} />
            <RepositoryReadNotice repoId="repo-a" />
            <AccessServiceTab autoLogin={autoLogin} auth={auth} access={undefined} repoId="repo-a" rootDir="/repo" />
          </QueryClientProvider>,
        ),
      );
    window.addEventListener("harness-auth-signed-in", signedIn);
    try {
      await renderTab(false);
      await flushUntil(() => statuses.length === 1);
      // The service surface confirms authenticated=true, then the daemon session expires and a
      // re-login starts from the business-read surface before the next 3s poll notices.
      await act(async () => {
        statuses[0]!.resolve({ ok: true, authenticated: true });
      });
      await flushUntil(() => container.querySelector('[data-testid="repository-read-state"]') !== null);
      await renderTab(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      await flushUntil(() => statuses.length === 2);
      fail.current = false;
      await act(async () => {
        statuses[1]!.resolve({ ok: true, authenticated: true });
      });
      await flushUntil(() => container.querySelector('[data-testid="probe-data"]')?.textContent === "rows");
      await flush();
      expect(signedIn).toHaveBeenCalledOnce();
      expect(container.querySelector('[data-testid="repository-read-notice"]')).toBeNull();
    } finally {
      window.removeEventListener("harness-auth-signed-in", signedIn);
    }
  });
});
