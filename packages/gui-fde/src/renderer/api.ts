import type { FdeDomainDraft, FdeLocale } from "@harness-anything/preset/fde-studio-draft";
import type {
  FdeBootstrapPayload,
  FdeCompiledPackage,
  FdePersistResult,
  FdeSimulationResult,
} from "../studio/studio-api.ts";

let cachedToken: string | null = null;

function readAccessToken(): string {
  if (cachedToken !== null) return cachedToken;
  const hash = globalThis.location?.hash ?? "";
  const match = /access_token=([^&]+)/u.exec(hash);
  if (match?.[1]) {
    cachedToken = decodeURIComponent(match[1]);
    globalThis.history?.replaceState(null, "", globalThis.location.pathname);
    return cachedToken;
  }
  return "";
}

async function apiRequest<T>(pathname: string, init?: RequestInit): Promise<T> {
  const token = readAccessToken();
  const response = await fetch(pathname, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const data = (await response.json()) as T & { readonly error?: { readonly message?: string } };
  if (!response.ok) {
    throw new Error(data.error?.message ?? `Request failed (${response.status})`);
  }
  return data;
}

export const fdeApi = {
  bootstrap: (): Promise<FdeBootstrapPayload> => apiRequest<FdeBootstrapPayload>("/api/bootstrap", { method: "GET" }),
  compile: (draft: FdeDomainDraft): Promise<FdeCompiledPackage> =>
    apiRequest<FdeCompiledPackage>("/api/compile", {
      method: "POST",
      body: JSON.stringify({ draft }),
    }),
  simulate: (draft: FdeDomainDraft, locale: FdeLocale): Promise<FdeSimulationResult> =>
    apiRequest<FdeSimulationResult>("/api/simulate", {
      method: "POST",
      body: JSON.stringify({ draft, locale }),
    }),
  persist: (draft: FdeDomainDraft, overwrite: boolean): Promise<FdePersistResult> =>
    apiRequest<FdePersistResult>("/api/persist", {
      method: "POST",
      body: JSON.stringify({ draft, overwrite, dryRun: false }),
    }),
};
