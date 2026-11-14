// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openRuntimeInstanceStore } from "../../daemon/src/agent-runtime-instance-store.ts";
import { RuntimeCard } from "../src/renderer/components/runtime/RuntimeCard.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import type { RuntimeInstanceUpdateInput } from "../src/renderer/runtime-instance-client.ts";

let root: Root | undefined, directory: string | undefined;
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = "";
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
  vi.restoreAllMocks();
});
function field<T extends HTMLElement>(id: string): T {
  const element = document.querySelector<T>(`[data-testid="${id}"]`);
  if (!element) throw new Error(`Missing ${id}`);
  return element;
}
async function click(id: string) {
  await act(async () => field<HTMLButtonElement>(id).click());
}
async function change(id: string, value: string) {
  await act(async () => {
    const element = field<HTMLSelectElement>(id);
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function fixture() {
  directory = mkdtempSync(path.join(tmpdir(), "ha-gui-credential-switch-"));
  const userRoot = directory,
    operatorHome = path.join(userRoot, "operator-home"),
    installations = ["agy-one", "agy-two"].map((installationId) => ({
      installationId,
      kindId: "agy" as const,
      executablePath: process.execPath,
      version: "1.1.15",
      observedAt: "2026-11-14T00:00:00Z",
    })),
    store = openRuntimeInstanceStore({
      userRoot,
      platform: "darwin",
      env: { HOME: operatorHome, PATH: "" },
      discover: () => installations,
    });
  await store.command({
    kind: "runtime-instance-create",
    instanceId: "agy-pro",
    name: "AGY Pro",
    kindId: "agy",
    installationId: "agy-one",
    providerId: "google",
    models: ["gemini-4-hydrogen-low"],
    authMode: "subscription",
    credentialSource: "instance",
  });
  const credential = path.join(userRoot, "runtime-instances/agy-pro/home/.gemini/antigravity-oauth-token"),
    operatorCredential = path.join(operatorHome, ".gemini/antigravity-oauth-token");
  mkdirSync(path.dirname(credential), { recursive: true });
  mkdirSync(path.dirname(operatorCredential), { recursive: true });
  writeFileSync(credential, "synthetic-independent-credential", { mode: 0o600 });
  writeFileSync(operatorCredential, "synthetic-operator-credential", { mode: 0o600 });
  const update = vi.fn(async (input: RuntimeInstanceUpdateInput) =>
      store.command({ kind: "runtime-instance-update", ...input }),
    ),
    container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      createElement(RuntimeCard, {
        instance: store.listPublic()[0]!,
        installations,
        independentCredentialsSupported: true,
        agents: [],
        liveSessions: 0,
        busy: false,
        projectAllowed: true,
        projectSettingsBusy: false,
        onSelectAgent: vi.fn(),
        onAuth: vi.fn(),
        onValidate: vi.fn(),
        onSelectRuntime: vi.fn(),
        onSetEnabled: vi.fn(),
        onSetProjectAllowed: vi.fn(),
        onUpdate: update,
        onDelete: vi.fn(),
        onSelfTest: vi.fn(),
      }),
    ),
  );
  return { store, update, credential, operatorCredential };
}

// dec_DA1602487428A58E8B446ECE38: source switching must disclose its destructive account effect.
for (const locale of ["en-US", "zh-CN"] as const)
  for (const target of ["source", "installation"] as const)
    it(`${locale}: confirms ${target} changes before the real update deletes an independent sign-in`, async () => {
      setActiveLocale(locale);
      const { store, update, credential, operatorCredential } = await fixture();
      const selectTarget = () =>
        change(
          target === "source" ? "runtime-provider-credential-source" : "runtime-provider-installation",
          target === "source" ? "operator" : "agy-two",
        );
      await click("runtime-provider-edit");
      await selectTarget();
      await click("runtime-provider-save");
      expect(update).not.toHaveBeenCalled();
      expect(existsSync(credential)).toBe(true);
      expect(field("runtime-provider-credential-warning").textContent).toMatch(
        locale === "en-US" ? /delete.*sign.in.*sign in again/iu : /删除.*登录.*重新登录/u,
      );
      await click("runtime-provider-cancel");
      expect(existsSync(credential)).toBe(true);
      expect(store.list()[0]!.credentialSource).toBe("instance");

      await click("runtime-provider-edit");
      await selectTarget();
      await click("runtime-provider-save");
      expect(update).not.toHaveBeenCalled();
      await click("runtime-provider-save");
      expect(update).toHaveBeenCalledTimes(1);
      if (target === "source") {
        expect(lstatSync(credential).isSymbolicLink()).toBe(true);
        expect(readFileSync(credential, "utf8")).toBe("synthetic-operator-credential");
      } else expect(existsSync(credential)).toBe(false);
      expect(readFileSync(operatorCredential, "utf8")).toBe("synthetic-operator-credential");
      expect(store.list()[0]!.credentialSource).toBe(target === "source" ? "operator" : "instance");
    });

it("saves ordinary metadata without deleting or confirming a credential", async () => {
  setActiveLocale("en-US");
  const { update, credential } = await fixture();
  await click("runtime-provider-edit");
  await click("runtime-provider-save");
  expect(update).toHaveBeenCalledTimes(1);
  expect(existsSync(credential)).toBe(true);
});
