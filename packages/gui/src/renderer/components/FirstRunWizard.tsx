import { useState, type FormEvent } from "react";
import type { FirstRunApi, FirstRunBootstrapInput } from "../../api/first-run-contract.ts";
import { consumeKnownError } from "../../api/error-consumption.ts";
import { t } from "../i18n/index.tsx";

export function FirstRunWizard({ onBootstrapped }: { readonly onBootstrapped: (repoId: string) => Promise<void> }) {
  const [rootDir, setRootDir] = useState("");
  const [repoId, setRepoId] = useState("");
  const [personId, setPersonId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [name, setName] = useState("");
  const [addNpmScripts, setAddNpmScripts] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const api = firstRunApi();
  const setRepositoryPath = (value: string) => {
    setRootDir(value);
    const folder = value.split(/[\\/]/u).filter(Boolean).at(-1) ?? "";
    if (!repoId) setRepoId(repositorySlug(folder));
    if (!name) setName(folder);
  };
  const chooseRepository = async () => {
    setError(null);
    try {
      const selected = await api.chooseRepository();
      if (selected) setRepositoryPath(selected);
    } catch (cause) {
      consumeKnownError(cause);
      setError(errorMessage(cause));
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const input: FirstRunBootstrapInput = {
      rootDir: rootDir.trim(),
      repoId: repoId.trim(),
      personId: personId.trim(),
      displayName: displayName.trim(),
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(addNpmScripts ? { addNpmScripts: true } : {}),
    };
    try {
      const receipt = await api.bootstrap(input);
      if (!successfulBootstrap(receipt)) throw new Error(receiptHint(receipt));
      await onBootstrapped(input.repoId);
    } catch (cause) {
      consumeKnownError(cause);
      setError(errorMessage(cause));
      setBusy(false);
    }
  };
  const ready =
    rootDir.trim().length > 0 &&
    /^[a-z][a-z0-9-]{0,62}$/u.test(repoId.trim()) &&
    /^[A-Za-z][A-Za-z0-9_-]{0,62}$/u.test(personId.trim()) &&
    displayName.trim().length > 0;

  return (
    <main data-testid="first-run-wizard" className="grid min-h-dvh place-items-center bg-surface px-5 py-8 text-text">
      <form
        className="w-full max-w-2xl rounded-xl border border-border-strong bg-surface-raised p-6 shadow-2xl"
        onSubmit={(event) => void submit(event)}
      >
        <p className="font-mono text-[11px] uppercase tracking-widest text-accent">{t("firstRun.stepRepository")}</p>
        <h1 className="mt-2 text-2xl font-semibold">{t("firstRun.title")}</h1>
        <p className="mt-2 text-sm leading-6 text-text-muted">{t("firstRun.subtitle")}</p>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <label className="sm:col-span-2">
            <span className="mb-1 block text-xs font-medium text-text-muted">{t("firstRun.repository")}</span>
            <span className="flex gap-2">
              <input
                data-testid="first-run-root"
                className="min-w-0 flex-1 rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs"
                value={rootDir}
                onChange={(event) => setRepositoryPath(event.target.value)}
                placeholder="/Users/you/Projects/my-repository"
              />
              <button
                type="button"
                className="rounded-md border border-border-strong px-3 text-sm hover:bg-surface"
                onClick={() => void chooseRepository()}
              >
                {t("firstRun.choose")}
              </button>
            </span>
          </label>
          <Field
            testId="first-run-repo-id"
            label={t("firstRun.repoId")}
            value={repoId}
            onChange={setRepoId}
            placeholder="my-repository"
            mono
          />
          <Field
            testId="first-run-name"
            label={t("firstRun.workspaceName")}
            value={name}
            onChange={setName}
            placeholder="My repository"
          />
          <Field
            testId="first-run-person-id"
            label={t("firstRun.personId")}
            value={personId}
            onChange={setPersonId}
            placeholder="person-owner"
            mono
          />
          <Field
            testId="first-run-display-name"
            label={t("firstRun.displayName")}
            value={displayName}
            onChange={setDisplayName}
            placeholder="Your name"
          />
        </div>

        <label className="mt-4 flex items-center gap-2 text-sm text-text-muted">
          <input type="checkbox" checked={addNpmScripts} onChange={(event) => setAddNpmScripts(event.target.checked)} />
          {t("firstRun.addNpmScripts")}
        </label>
        {error ? (
          <p role="alert" className="mt-4 rounded-md bg-status-blocked/10 px-3 py-2 text-sm text-status-blocked">
            {error}
          </p>
        ) : null}
        <div className="mt-6 flex items-center justify-between gap-4">
          <span className="text-xs text-text-faint">{t("firstRun.localOnly")}</span>
          <button
            data-testid="first-run-bootstrap"
            type="submit"
            disabled={!ready || busy}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            {busy ? t("firstRun.initializing") : t("firstRun.initialize")}
          </button>
        </div>
      </form>
    </main>
  );
}

export function FirstRunGuide({
  stage,
  onNext,
  onFinish,
}: {
  readonly stage: "provider" | "agent";
  readonly onNext: () => void;
  readonly onFinish: () => void;
}) {
  const provider = stage === "provider";
  return (
    <aside
      data-testid="first-run-guide"
      className="fixed right-5 bottom-5 z-50 w-80 rounded-xl border border-accent/50 bg-surface-raised p-4 shadow-2xl"
    >
      <p className="font-mono text-[10px] uppercase tracking-widest text-accent">
        {t(provider ? "firstRun.stepProvider" : "firstRun.stepAgent")}
      </p>
      <h2 className="mt-1 text-base font-semibold">{t(provider ? "firstRun.providerTitle" : "firstRun.agentTitle")}</h2>
      <p className="mt-2 text-xs leading-5 text-text-muted">
        {t(provider ? "firstRun.providerHint" : "firstRun.agentHint")}
      </p>
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          data-testid={provider ? "first-run-next-agent" : "first-run-finish"}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white"
          onClick={provider ? onNext : onFinish}
        >
          {t(provider ? "firstRun.nextAgent" : "firstRun.finish")}
        </button>
      </div>
    </aside>
  );
}

function Field({
  testId,
  label,
  value,
  placeholder,
  mono = false,
  onChange,
}: {
  readonly testId: string;
  readonly label: string;
  readonly value: string;
  readonly placeholder: string;
  readonly mono?: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label>
      <span className="mb-1 block text-xs font-medium text-text-muted">{label}</span>
      <input
        data-testid={testId}
        className={`w-full rounded-md border border-border bg-surface px-3 py-2 text-sm ${mono ? "font-mono" : ""}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}

function firstRunApi(): FirstRunApi {
  const api = window.harness?.firstRun;
  if (!api) throw new Error("First-run preload bridge is unavailable.");
  return api;
}

function repositorySlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 63);
  return /^[a-z]/u.test(slug) ? slug : `repo-${slug || "local"}`;
}

function successfulBootstrap(value: unknown): value is { readonly ok: true } {
  return record(value) && value.ok === true;
}

function receiptHint(value: unknown): string {
  return record(value) && record(value.error) && typeof value.error.hint === "string"
    ? value.error.hint
    : "Repository initialization was rejected.";
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
