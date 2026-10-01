import { TabPanel } from "../components/primitives/EntryBoundary.tsx";
import type { CSSProperties } from "react";
import { useState } from "react";
import { ArrowClockwise } from "@phosphor-icons/react";
import { useCatalogReread, useCatalogSnapshot } from "../catalog-data.ts";
import type { CatalogPresetRow } from "../api-client-catalog.ts";
import { formatTime } from "../model/time.ts";
import { PresetDetailView } from "./PresetDetailView.tsx";
import { t } from "../i18n/index.tsx";
import { DenseRow } from "../components/primitives/DenseRow.tsx";
import { PageHeader } from "../components/primitives/PageHeader.tsx";
import { StatusTag, TONE_COLOR, type StatusTone } from "../components/primitives/StatusTag.tsx";
import { Tabs } from "../components/primitives/Tabs.tsx";
import { TitleText } from "../components/primitives/TitleText.tsx";

type Tab = "presets" | "verticals" | "templates";

/** 有效性 → 状态色档(标准 §3):valid 绿、unavailable 琥珀、blocked 红。 */
const VALIDITY_TONE: Record<CatalogPresetRow["validity"], StatusTone> = {
  valid: "done",
  unavailable: "wait",
  blocked: "bad",
};

/**
 * 预设目录页(标准 §2.5):回答「有哪些预设、哪个坏了、哪个是默认」。每预设一行
 * DenseRow,有效性用有底色的 StatusTag,blocked 置顶并带红竖线;详情整页深链
 * (preset/<id> 推栈,回撤原路返回),与实体的目录范式一致。垂直领域与模板同版式。
 */
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
    reread = useCatalogReread(repoId);
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
  const presets = orderPresets(data.presets),
    blocked = data.presets.filter((preset) => preset.validity === "blocked").length;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <PageHeader
        title={t("views.presetsView.catalogPreset")}
        note={t("views.presetsView.activationDescription")}
        meta={
          <>
            {blocked > 0 ? (
              <StatusTag tone="bad" label={t("views.presetsView.blockedCount", { count: blocked })} />
            ) : null}
            {repoId} · {data.status}
            {data.observedAt
              ? ` · ${t("views.presetsView.observedAt")} ${
                  formatTime(data.observedAt, { style: "date-time-seconds" }) ??
                  t("views.presetsView.unknownNotProjected")
                }`
              : ""}
          </>
        }
        actions={
          <button
            disabled={reread.isPending}
            onClick={() => reread.mutate()}
            className="inline-flex items-center gap-1 rounded-xs border border-border px-2 py-1 ui-meta text-text-muted hover:border-border-strong disabled:opacity-50"
          >
            <ArrowClockwise />
            {t("views.presetsView.reread")}
          </button>
        }
      />
      {reread.data && (
        <p className={`px-5 font-mono ui-micro ${reread.data.ok ? "text-status-done" : "text-status-blocked"}`}>
          {t("views.presetsView.operationId")} {reread.data.operationId} · {reread.data.outcome} ·{" "}
          {formatTime(reread.data.observedAt, { style: "date-time-seconds" }) ?? reread.data.observedAt}
          {reread.data.error ? ` · ${reread.data.error.code}: ${reread.data.error.hint}` : ""}
        </p>
      )}
      <Tabs
        ariaLabel={t("views.presetsView.catalogPreset")}
        idPrefix="presets"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "presets", label: t("views.presetsView.presetsTab"), count: data.presets.length },
          { key: "verticals", label: t("views.presetsView.verticalsTab"), count: data.verticals.length },
          { key: "templates", label: t("views.presetsView.templatesTab"), count: data.templates.length },
        ]}
      />
      <TabPanel idPrefix="presets" value={tab} data-testid="presets-content" className="w-full p-4">
        {tab === "presets" &&
          presets.map((preset) => (
            <div
              key={`${preset.sourceKind}:${preset.id}`}
              data-testid="preset-row"
              onClick={() => onOpenPreset(preset.id)}
              className="status-edge relative w-full cursor-pointer hover:bg-text/5"
              style={preset.validity === "blocked" ? ({ "--status-edge": TONE_COLOR.bad } as CSSProperties) : undefined}
            >
              <DenseRow
                tag={<StatusTag tone={VALIDITY_TONE[preset.validity]} label={preset.validity} />}
                title={
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate">
                      <TitleText title={preset.title} />
                    </span>
                    <span className="shrink-0 font-mono ui-micro text-text-faint">{preset.id}</span>
                    <span className="shrink-0 rounded-xs border border-border px-1.5 py-px font-mono ui-micro text-text-muted">
                      {preset.sourceKind}
                    </span>
                    {preset.id === data.defaults.presetId ? (
                      <span className="shrink-0 rounded-xs border border-accent/60 px-1.5 py-px font-mono ui-micro text-accent">
                        {t("views.presetsView.default")}
                      </span>
                    ) : null}
                  </span>
                }
                reason={
                  preset.issues.length > 0
                    ? `${t("views.presetsView.issuesCount", { count: preset.issues.length })} · ${preset.description || t("views.presetsView.unknownNotProjected")}`
                    : preset.shadows
                      ? `${t("views.presetsView.shadowBundled")}: ${preset.shadows.title} · ${preset.description || ""}`
                      : preset.description || t("views.presetsView.unknownNotProjected")
                }
                time={`${preset.verticalId} · ${t("views.presetsView.version")} ${
                  preset.version ?? t("views.presetsView.unknownNotProjected")
                }`}
              />
            </div>
          ))}
        {tab === "verticals" &&
          data.verticals.map((vertical) => (
            <DenseRow
              key={vertical.id}
              tag={
                <StatusTag
                  tone={vertical.valid ? "done" : "bad"}
                  label={vertical.valid ? t("views.presetsView.valid") : t("views.presetsView.invalid")}
                />
              }
              title={
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate">{vertical.title}</span>
                  <span className="shrink-0 font-mono ui-micro text-text-faint">{vertical.id}</span>
                </span>
              }
              reason={`${t("views.presetsView.source")} ${vertical.source}${
                vertical.issues.length > 0
                  ? ` · ${t("views.presetsView.issuesCount", { count: vertical.issues.length })}`
                  : ""
              }`}
              time={!vertical.available ? t("views.presetsView.unavailable") : vertical.version}
            />
          ))}
        {tab === "templates" &&
          data.templates.map((template) => (
            <DenseRow
              key={`${template.slot}:${template.templateRef}`}
              tag={<StatusTag tone="neutral" label={template.slot} />}
              title={template.templateRef}
              reason={`${template.templateRef} → ${template.materializeAs}`}
              time={template.locales.join(", ") || t("views.presetsView.unknownNotProjected")}
            />
          ))}
        {((tab === "presets" && data.presets.length === 0) ||
          (tab === "verticals" && data.verticals.length === 0) ||
          (tab === "templates" && data.templates.length === 0)) && (
          <p className="ui-meta text-text-faint">{t("views.presetsView.emptyTab")}</p>
        )}
      </TabPanel>
    </div>
  );
}

/** blocked 置顶,其余按默认优先、再按 id 稳定排序(标准 §2.5 异常项置顶)。 */
function orderPresets(presets: ReadonlyArray<CatalogPresetRow>): ReadonlyArray<CatalogPresetRow> {
  return [...presets].sort((left, right) => {
    const blocked = Number(right.validity === "blocked") - Number(left.validity === "blocked");
    if (blocked !== 0) return blocked;
    return left.id.localeCompare(right.id);
  });
}

function State({ text, danger = false }: { readonly text: string; readonly danger?: boolean }) {
  return <div className={`p-6 ui-body ${danger ? "text-status-blocked" : "text-text-faint"}`}>{text}</div>;
}
