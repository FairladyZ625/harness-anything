import { useState } from "react";
import { ArrowClockwise, Stack } from "@phosphor-icons/react";
import { useCatalogReread, useCatalogSnapshot } from "../catalog-data.ts";
import { PresetBadge } from "../components/presetDetail/PresetDetailSections.tsx";
import { formatTime } from "../model/time.ts";
import { PresetDetailView } from "./PresetDetailView.tsx";
import { t } from "../i18n/index.tsx";

type Tab = "presets" | "verticals" | "templates";
const tabs: ReadonlyArray<Tab> = ["presets", "verticals", "templates"];

export function PresetsView({
  repoId,
  focusedPresetId,
  onOpenPreset,
  onExitDetail,
  projectName,
}: {
  readonly repoId: string;
  /** preset/<id> 深链接解析出的详情落点;null = 目录列表页。 */
  readonly focusedPresetId: string | null;
  readonly onOpenPreset: (presetId: string) => void;
  readonly onExitDetail: () => void;
  readonly projectName: string;
}) {
  const snapshot = useCatalogSnapshot(repoId),
    data = snapshot.data,
    reread = useCatalogReread(repoId, data?.catalogDigest);
  const [tab, setTab] = useState<Tab>("presets");
  if (snapshot.isPending) return <State text={t("views.presetsView.readingCatalogSnapshot")} />;
  if (snapshot.isError || !data)
    return (
      <State
        danger
        text={t("views.presetsView.catalogReadFailed", {
          error: snapshot.error instanceof Error ? snapshot.error.message : t("views.presetsView.unknownNotProjected"),
        })}
      />
    );
  const locale = data.defaults.locale;
  if (focusedPresetId)
    return (
      <PresetDetailView
        repoId={repoId}
        presetId={focusedPresetId}
        locale={locale}
        row={data.presets.find((preset) => preset.id === focusedPresetId) ?? null}
        isDefault={focusedPresetId === data.defaults.presetId}
        projectName={projectName}
        fromViewLabel={t("views.presetsView.catalogPreset")}
        onBack={onExitDetail}
      />
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Stack className="text-text-faint" />
          <h1 className="ui-title font-semibold">{t("views.presetsView.catalogPreset")}</h1>
          <span className="font-mono text-[11px] text-text-faint">
            {repoId} · {data.status} · {data.catalogDigest.slice(0, 18)}…
          </span>
          <button
            disabled={reread.isPending}
            onClick={() => reread.mutate()}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] text-text-muted hover:border-border-strong disabled:opacity-50"
          >
            <ArrowClockwise />
            {t("views.presetsView.reread")}
          </button>
        </div>
        <p className="mt-1 text-[12px] text-text-faint">
          {t("views.presetsView.activationDescription")} <span className="font-mono text-text-muted">{locale}</span>
          {data.observedAt ? (
            <>
              {" · "}
              {t("views.presetsView.observedAt")}{" "}
              <span className="font-mono text-text-muted">
                {formatTime(data.observedAt, { style: "date-time-seconds" }) ??
                  t("views.presetsView.unknownNotProjected")}
              </span>
            </>
          ) : null}
        </p>
        {reread.data && (
          <p className={`mt-1 font-mono text-[11px] ${reread.data.ok ? "text-status-done" : "text-status-blocked"}`}>
            {t("views.presetsView.operationId")} {reread.data.operationId} · {reread.data.outcome} ·{" "}
            {formatTime(reread.data.observedAt, { style: "date-time-seconds" }) ?? reread.data.observedAt} ·{" "}
            {reread.data.beforeDigest.slice(0, 14)} → {reread.data.afterDigest.slice(0, 14)}
            {reread.data.error ? ` · ${reread.data.error.code}: ${reread.data.error.hint}` : ""}
          </p>
        )}
      </header>
      <div className="flex gap-1 border-b border-border px-4 py-2">
        {tabs.map((item) => (
          <button
            key={item}
            onClick={() => setTab(item)}
            className={`rounded-md px-3 py-1 text-[12px] ${tab === item ? "bg-surface-raised font-semibold text-text" : "text-text-muted hover:text-text"}`}
          >
            {t(
              `views.presetsView.${item}Tab` as
                | "views.presetsView.presetsTab"
                | "views.presetsView.verticalsTab"
                | "views.presetsView.templatesTab",
            )}
          </button>
        ))}
      </div>
      <div data-testid="presets-content" className="w-full space-y-1.5 p-4">
        {tab === "presets" &&
          data.presets.map((preset) => (
            <button
              key={`${preset.sourceKind}:${preset.id}`}
              onClick={() => onOpenPreset(preset.id)}
              data-testid="preset-row"
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-left hover:border-border-strong"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <b className="shrink-0 text-[13px]">{preset.title}</b>
                <code className="shrink-0 font-mono text-[11px] text-text-faint">{preset.id}</code>
                <PresetBadge value={preset.sourceKind} />
                <PresetBadge value={preset.validity} />
                {preset.id === data.defaults.presetId && (
                  <PresetBadge value={t("views.presetsView.default")} tone="accent" />
                )}
                <span className="ml-auto shrink-0 font-mono text-[11px] text-text-faint">
                  {preset.verticalId} · {t("views.presetsView.version")}{" "}
                  {preset.version ?? t("views.presetsView.unknownNotProjected")}
                </span>
              </div>
              <p className="mt-0.5 truncate text-[12px] text-text-muted">
                {preset.description || t("views.presetsView.unknownNotProjected")}
              </p>
              {preset.shadows && (
                <p className="mt-0.5 text-[11px] text-stale">
                  {t("views.presetsView.shadowBundled")}：{preset.shadows.title}
                </p>
              )}
              {preset.issues.length > 0 && (
                <pre className="mt-1.5 overflow-auto whitespace-pre-wrap rounded bg-surface-raised p-2 text-[11px] text-status-blocked">
                  {JSON.stringify(preset.issues, null, 2)}
                </pre>
              )}
            </button>
          ))}
        {tab === "verticals" &&
          data.verticals.map((vertical) => (
            <article key={vertical.id} className="rounded-lg border border-border bg-surface p-3">
              <div className="flex items-center gap-2">
                <b>{vertical.title}</b>
                <code className="text-[11px] text-text-faint">
                  {vertical.id}@{vertical.version}
                </code>
                <PresetBadge value={vertical.valid ? t("views.presetsView.valid") : t("views.presetsView.invalid")} />
                <PresetBadge
                  value={vertical.available ? t("views.presetsView.available") : t("views.presetsView.unavailable")}
                />
              </div>
              <p className="mt-1 font-mono text-[11px] text-text-faint">
                {t("views.presetsView.source")} {vertical.source}
              </p>
              {vertical.issues.length > 0 && (
                <pre className="mt-2 whitespace-pre-wrap text-[11px] text-status-blocked">
                  {JSON.stringify(vertical.issues, null, 2)}
                </pre>
              )}
            </article>
          ))}
        {tab === "templates" &&
          data.templates.map((template) => (
            <article
              key={`${template.slot}:${template.templateRef}`}
              className="rounded-lg border border-border bg-surface p-3"
            >
              <b className="text-[13px]">{template.slot}</b>
              <p className="mt-1 break-all font-mono text-[11px] text-text-muted">
                {template.templateRef} → {template.materializeAs}
              </p>
              <p className="mt-1 text-[11px] text-text-faint">
                {t("views.presetsView.locale")}：
                {template.locales.join(", ") || t("views.presetsView.unknownNotProjected")} ·{" "}
                {t("views.presetsView.snapshotDefault")} {data.defaults.locale}
              </p>
            </article>
          ))}
      </div>
    </div>
  );
}
function State({ text, danger = false }: { readonly text: string; readonly danger?: boolean }) {
  return <div className={`p-6 text-[13px] ${danger ? "text-status-blocked" : "text-text-faint"}`}>{text}</div>;
}
