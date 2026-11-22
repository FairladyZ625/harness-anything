import {
  BookOpenText,
  Cube,
  FileCode,
  FloppyDisk,
  Globe,
  Play,
  Robot,
  ShieldCheck,
  SlidersHorizontal,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { createDefaultFdeDraft, type FdeDomainDraft, type FdeLocale } from "../studio/domain-draft.ts";
import { consumeKnownError } from "../studio/error-consumption.ts";
import type { FdeCompiledPackage, FdePersistResult, FdeSimulateReportDto } from "../studio/studio-api.ts";
import { fdeApi } from "./api.ts";
import { AgentsSection } from "./sections/AgentsSection.tsx";
import { DossierSection } from "./sections/DossierSection.tsx";
import { EntitiesSection } from "./sections/EntitiesSection.tsx";
import { GatesSection } from "./sections/GatesSection.tsx";
import { PresetsSection } from "./sections/PresetsSection.tsx";
import { GateSimulatorPane } from "./panes/GateSimulatorPane.tsx";
import { HtmlSandboxPane } from "./panes/HtmlSandboxPane.tsx";
import { MaterializedTreePane } from "./panes/MaterializedTreePane.tsx";

type BuilderSection = "entities" | "gates" | "presets" | "agents" | "dossier";
type PreviewTab = "files" | "html" | "simulator";

const BUILDER_NAV: readonly { readonly id: BuilderSection; readonly label: string }[] = [
  { id: "entities", label: "① 实体与关系" },
  { id: "gates", label: "② 完成门绑定" },
  { id: "presets", label: "③ Preset 模板" },
  { id: "agents", label: "④ 角色 Agent" },
  { id: "dossier", label: "⑤ 活档案规则" },
];

export function App() {
  const [draft, setDraft] = useState<FdeDomainDraft>(() => createDefaultFdeDraft());
  const [section, setSection] = useState<BuilderSection>("entities");
  const [previewTab, setPreviewTab] = useState<PreviewTab>("simulator");
  const [compiled, setCompiled] = useState<FdeCompiledPackage | null>(null);
  const [report, setReport] = useState<FdeSimulateReportDto | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [persisting, setPersisting] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [persistResult, setPersistResult] = useState<FdePersistResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const runCompile = useCallback(async (targetDraft: FdeDomainDraft) => {
    try {
      const next = await fdeApi.compile(targetDraft);
      setCompiled(next);
      setErrorMessage(null);
    } catch (error) {
      consumeKnownError(error);
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const runSimulate = useCallback(async (targetDraft: FdeDomainDraft, locale: FdeLocale) => {
    setSimulating(true);
    try {
      const result = await fdeApi.simulate(targetDraft, locale);
      setCompiled(result.compiled);
      setReport(result.report);
      setErrorMessage(null);
    } catch (error) {
      consumeKnownError(error);
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSimulating(false);
    }
  }, []);

  useEffect(() => {
    void fdeApi
      .bootstrap()
      .then((payload) => {
        setDraft(payload.draft);
        return runSimulate(payload.draft, payload.draft.locale);
      })
      .catch((error) => {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      });
  }, [runSimulate]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void runCompile(draft);
    }, 180);
    return () => clearTimeout(timer);
  }, [draft, runCompile]);

  const handlePersist = async () => {
    setPersisting(true);
    try {
      const receipt = await fdeApi.persist(draft, overwrite);
      setPersistResult(receipt);
      setErrorMessage(null);
    } catch (error) {
      consumeKnownError(error);
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPersisting(false);
    }
  };

  const sectionIcon = (id: BuilderSection) => {
    if (id === "entities") return <Cube size={14} />;
    if (id === "gates") return <ShieldCheck size={14} />;
    if (id === "presets") return <SlidersHorizontal size={14} />;
    if (id === "agents") return <Robot size={14} />;
    return <BookOpenText size={14} />;
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[var(--color-bg)] text-[var(--color-text)]">
      <header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-bold tracking-wide text-[var(--color-accent)]">FDE STUDIO</span>
          <label className="sr-only" htmlFor="fde-vertical-id">
            Vertical ID
          </label>
          <input
            id="fde-vertical-id"
            value={draft.verticalId}
            onChange={(event) => {
              const verticalId = event.target.value;
              setDraft({ ...draft, verticalId, slug: verticalId.replaceAll("/", "-") });
            }}
            className="h-7 w-44 font-mono text-xs"
          />
          <label className="sr-only" htmlFor="fde-vertical-title">
            Vertical Title
          </label>
          <input
            id="fde-vertical-title"
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            className="h-7 w-44 text-xs"
          />
          <label className="sr-only" htmlFor="fde-locale">
            Locale
          </label>
          <select
            id="fde-locale"
            value={draft.locale}
            onChange={(event) => setDraft({ ...draft, locale: event.target.value as FdeLocale })}
            className="h-7 font-mono text-xs"
          >
            <option value="zh-CN">zh-CN</option>
            <option value="en-US">en-US</option>
          </select>
        </div>

        <div className="flex items-center gap-2">
          {errorMessage ? (
            <span className="max-w-72 truncate font-mono text-[11px] text-[var(--color-fail)]" title={errorMessage}>
              {errorMessage}
            </span>
          ) : persistResult ? (
            <span className="font-mono text-[11px] text-[var(--color-pass)]">
              Saved {persistResult.targetDir} ({persistResult.created.length + persistResult.overwritten.length})
            </span>
          ) : null}

          <label className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]">
            <input type="checkbox" checked={overwrite} onChange={(event) => setOverwrite(event.target.checked)} />
            Overwrite
          </label>
          <button
            type="button"
            disabled={simulating}
            onClick={() => void runSimulate(draft, draft.locale)}
            className="inline-flex h-7 items-center gap-1 rounded bg-[var(--color-accent)] px-3 text-xs font-semibold text-[var(--color-accent-fg)] disabled:opacity-50"
          >
            <Play size={13} weight="fill" /> {simulating ? "仿真中…" : "仿真门禁"}
          </button>
          <button
            type="button"
            disabled={persisting}
            onClick={() => void handlePersist()}
            className={`inline-flex h-7 items-center gap-1 rounded border px-3 text-xs font-medium disabled:opacity-50 ${
              overwrite
                ? "border-[var(--color-warn)] text-[var(--color-warn)]"
                : "border-[var(--color-border-strong)] bg-[var(--color-surface-raised)]"
            }`}
          >
            <FloppyDisk size={13} />
            {overwrite ? `覆盖保存 verticals/${draft.slug}` : `保存 verticals/${draft.slug}`}
          </button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(480px,48%)_1fr]">
        <section
          aria-label="Domain Builder"
          className="flex min-h-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-bg)]"
        >
          <nav
            aria-label="Builder Sections"
            className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5"
          >
            {BUILDER_NAV.map((item) => {
              const active = section === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => setSection(item.id)}
                  className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded border px-2.5 text-xs font-medium ${
                    active
                      ? "border-[var(--color-accent)] bg-[color-mix(in_oklch,var(--color-accent)_16%,transparent)] text-[var(--color-accent)]"
                      : "border-transparent text-[var(--color-text-muted)] hover:border-[var(--color-border)]"
                  }`}
                >
                  {sectionIcon(item.id)}
                  {item.label}
                </button>
              );
            })}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {section === "entities" ? <EntitiesSection draft={draft} onChange={setDraft} /> : null}
            {section === "gates" ? <GatesSection draft={draft} onChange={setDraft} /> : null}
            {section === "presets" ? <PresetsSection draft={draft} onChange={setDraft} /> : null}
            {section === "agents" ? <AgentsSection draft={draft} onChange={setDraft} /> : null}
            {section === "dossier" ? (
              <DossierSection draft={draft} validation={compiled?.dossierValidation} onChange={setDraft} />
            ) : null}
          </div>
        </section>

        <section aria-label="Live Preview and Gate Simulator" className="flex min-h-0 flex-col overflow-hidden">
          <div
            role="tablist"
            aria-label="Preview Views"
            className="flex shrink-0 items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5"
          >
            <button
              type="button"
              role="tab"
              aria-selected={previewTab === "files"}
              onClick={() => setPreviewTab("files")}
              className={`inline-flex h-7 items-center gap-1.5 rounded border px-2.5 text-xs font-medium ${
                previewTab === "files"
                  ? "border-[var(--color-accent)] bg-[color-mix(in_oklch,var(--color-accent)_16%,transparent)] text-[var(--color-accent)]"
                  : "border-transparent text-[var(--color-text-muted)]"
              }`}
            >
              <FileCode size={14} /> ① 物化文件 ({compiled?.files.length ?? 0})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={previewTab === "html"}
              onClick={() => setPreviewTab("html")}
              className={`inline-flex h-7 items-center gap-1.5 rounded border px-2.5 text-xs font-medium ${
                previewTab === "html"
                  ? "border-[var(--color-accent)] bg-[color-mix(in_oklch,var(--color-accent)_16%,transparent)] text-[var(--color-accent)]"
                  : "border-transparent text-[var(--color-text-muted)]"
              }`}
            >
              <Globe size={14} /> ② HTML 沙箱
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={previewTab === "simulator"}
              onClick={() => setPreviewTab("simulator")}
              className={`inline-flex h-7 items-center gap-1.5 rounded border px-2.5 text-xs font-medium ${
                previewTab === "simulator"
                  ? "border-[var(--color-accent)] bg-[color-mix(in_oklch,var(--color-accent)_16%,transparent)] text-[var(--color-accent)]"
                  : "border-transparent text-[var(--color-text-muted)]"
              }`}
            >
              <ShieldCheck size={14} /> ③ 门禁仿真 ({report?.gates.length ?? 0})
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            {previewTab === "files" ? <MaterializedTreePane compiled={compiled} report={report} /> : null}
            {previewTab === "html" ? <HtmlSandboxPane previews={compiled?.htmlPreviews ?? null} /> : null}
            {previewTab === "simulator" ? (
              <GateSimulatorPane
                report={report}
                simulating={simulating}
                onSimulate={() => void runSimulate(draft, draft.locale)}
              />
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
