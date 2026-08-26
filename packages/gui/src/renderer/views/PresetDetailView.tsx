import { useEffect, useState, type KeyboardEvent } from "react";
import { ArrowLeft, CaretRight, FileText, Info } from "@phosphor-icons/react";
import type { CatalogPresetRow } from "../api-client.ts";
import {
  PresetBadge,
  PresetDocumentPanel,
  PresetDocumentSidebar,
  PresetOverviewTab,
  PresetShaField,
} from "../components/presetDetail/PresetDetailSections.tsx";
import { useCatalogPreset } from "../catalog-data.ts";
import { t } from "../i18n/index.tsx";

/**
 * G7 Preset 详情页:与 Task 详情同构(面包屑头部 + 分区页签 + 容器化主体),
 * 深链接 preset/<id> 落此,回撤原路返回。元数据与包内文档正文全部来自
 * gui-catalog-preset/v1 读面(resolver 单一权威),GUI 不读文件系统。
 */

const tabs = [
  { id: "overview", icon: Info },
  { id: "files", icon: FileText },
] as const;

type PresetDetailTab = (typeof tabs)[number]["id"];

export function PresetDetailView({
  repoId,
  presetId,
  locale,
  row,
  isDefault = false,
  projectName,
  fromViewLabel,
  onBack,
}: {
  readonly repoId: string;
  readonly presetId: string;
  readonly locale: string;
  /** 目录列表行(标题/来源/有效性);引用过期时为 null,仍可按 id 读详情。 */
  readonly row: CatalogPresetRow | null;
  readonly isDefault?: boolean;
  readonly projectName: string;
  readonly fromViewLabel: string;
  readonly onBack: () => void;
}) {
  const detail = useCatalogPreset(repoId, presetId, locale),
    [activeTab, setActiveTab] = useState<PresetDetailTab>("overview"),
    [activeDoc, setActiveDoc] = useState("");

  useEffect(() => {
    setActiveTab("overview");
    setActiveDoc("");
  }, [presetId, locale]);

  const documents = detail.data?.resolved.documents ?? [],
    openDocument = (path: string) => {
      setActiveDoc(path);
      setActiveTab("files");
    };

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg" data-testid="preset-detail-view">
      <header
        className="relative z-20 shrink-0 border-b border-border bg-surface/80"
        data-testid="preset-detail-header"
      >
        <div className="flex min-h-14 items-center gap-2.5 px-3 py-2 lg:px-4">
          <button
            type="button"
            onClick={onBack}
            aria-label={t("views.presetDetailView.returnPreviousLevel")}
            className={[
              "grid size-7 shrink-0 place-items-center rounded-md border border-border text-text-muted",
              "hover:border-border-strong hover:bg-surface-raised hover:text-text",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
            ].join(" ")}
          >
            <ArrowLeft weight="bold" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1 font-mono text-[9px] leading-3 text-text-faint">
              <button type="button" onClick={onBack} className="truncate hover:text-text-muted">
                {projectName}
              </button>
              <CaretRight weight="bold" className="shrink-0" />
              <button type="button" onClick={onBack} className="truncate hover:text-text-muted">
                {fromViewLabel}
              </button>
              <CaretRight weight="bold" className="shrink-0" />
              <span className="truncate font-mono text-[9px] leading-3 text-text-muted">{presetId}</span>
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-2">
              <h1 className="truncate text-[16px] font-semibold leading-5 tracking-[-0.01em] text-text">
                {row?.title ?? presetId}
              </h1>
              {row ? <PresetBadge value={row.sourceKind} /> : null}
              {row ? <PresetBadge value={row.validity} /> : null}
              {isDefault ? <PresetBadge value={t("views.presetsView.default")} tone="accent" /> : null}
            </div>
          </div>
          <details className="group relative shrink-0">
            <summary
              className={[
                "list-none rounded-md border border-border px-2 py-1.5 font-mono text-[10px] text-text-muted",
                "hover:border-border-strong hover:bg-surface-raised hover:text-text",
                "[&::-webkit-details-marker]:hidden",
              ].join(" ")}
            >
              {t("views.presetDetailView.identity")}
            </summary>
            <dl
              className={[
                "absolute right-0 top-[calc(100%+0.5rem)] z-40 grid w-[min(44rem,calc(100vw-2rem))]",
                "overflow-hidden rounded-lg border border-border-strong bg-surface shadow-2xl",
                "sm:grid-cols-2 lg:grid-cols-3",
              ].join(" ")}
              data-testid="preset-identity-strip"
            >
              <IdentityItem label="PRESET ID" value={presetId} />
              <IdentityItem label="VERTICAL" value={row?.verticalId ?? detail.data?.preset.verticalId ?? "—"} />
              <IdentityItem label="EXTENDS" value={detail.data?.preset.extends ?? "—"} />
              <IdentityItem label="VERSION" value={detail.data?.preset.version ?? row?.version ?? "—"} />
              <IdentityItem label="LOCALE" value={locale} />
              <IdentityItem label="DEFAULT PROFILE" value={row?.defaultProfile ?? "—"} />
              <IdentityItem label="ENTRYPOINTS" value={row?.entrypoints.join(", ") || "—"} wide />
              <div className="min-w-0 border-r border-b border-border/70 px-3 py-2 sm:col-span-2 lg:col-span-3">
                {/* DIGEST 格:值是 PresetShaField 自带的 <dt>/<dd> 结构,外层不再包
                    <dd>(<dd> 嵌套 <dt>/<dd> 是 G12 §5 的三条 console error 根因);
                    未解析时才由本格直接给 <dt>/<dd>。 */}
                {detail.data ? (
                  <PresetShaField name="resolved.digest" value={detail.data.resolved.digest} />
                ) : (
                  <>
                    <dt className="font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-text-faint">
                      DIGEST
                    </dt>
                    <dd className="mt-1 font-mono text-[11px] text-text-faint">—</dd>
                  </>
                )}
              </div>
            </dl>
          </details>
        </div>
      </header>

      <nav
        role="tablist"
        aria-label={t("views.presetDetailView.tablist")}
        className="relative z-10 flex h-8 shrink-0 overflow-x-auto border-b border-border bg-surface px-2 sm:px-3"
      >
        {tabs.map((tab, index) => {
          const Icon = tab.icon,
            active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              id={`preset-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`preset-panel-${tab.id}`}
              tabIndex={active ? 0 : -1}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(event) => navigateTabs(event, index, setActiveTab)}
              className={[
                "relative flex h-8 shrink-0 items-center gap-1 px-2 text-[11px] font-medium",
                "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent",
                active ? "text-text" : "text-text-faint hover:text-text-muted",
              ].join(" ")}
            >
              <Icon weight={active ? "bold" : "regular"} className="text-[12px]" />
              {tab.id === "overview" ? t("views.presetDetailView.overviewTab") : t("views.presetDetailView.packageTab")}
              {active ? <span className="absolute inset-x-2 bottom-0 h-0.5 bg-accent" /> : null}
            </button>
          );
        })}
      </nav>

      {/* 宽屏自适应(复用 G1/G5 容器规则):main 是容器量尺,卡片铺满可用宽度。
          断带与 Task 详情一致:<1100px 侧栏横排在上,≥1100px 收窄为 14rem 侧栏。 */}
      <main className="@container min-h-0 flex-1 overflow-hidden px-3 py-3 sm:px-4" data-testid="preset-detail-content">
        <div
          className={[
            "h-full w-full overflow-hidden rounded-lg border border-border bg-bg",
            "grid grid-cols-1 grid-rows-[auto_minmax(0,1fr)]",
            "@min-[1100px]:grid-cols-[14rem_minmax(0,1fr)] @min-[1100px]:grid-rows-1",
          ].join(" ")}
        >
          <PresetDocumentSidebar documents={documents} activeDoc={activeDoc} onOpenDoc={openDocument} />
          <section
            id={`preset-panel-${activeTab}`}
            role="tabpanel"
            aria-labelledby={`preset-tab-${activeTab}`}
            className="min-h-0 min-w-0 overflow-y-auto px-4 py-5 lg:px-6"
            data-testid="preset-detail-panel-scroll"
          >
            {detail.isPending ? (
              <p className="text-[12px] text-text-faint">{t("views.presetsView.resolving", { locale })}</p>
            ) : detail.isError ? (
              <p className="text-[12px] text-status-blocked">
                {t("views.presetsView.unknownNotProjected")}:{" "}
                {detail.error instanceof Error ? detail.error.message : t("views.presetsView.notSelected")}
              </p>
            ) : !detail.data ? (
              <p className="text-[12px] text-text-faint">{t("views.presetsView.notSelected")}</p>
            ) : activeTab === "overview" ? (
              <PresetOverviewTab detail={detail.data} row={row} locale={locale} />
            ) : documents.length === 0 ? (
              <p className="text-[12px] text-text-faint">{t("views.presetDetailView.noDocuments")}</p>
            ) : activeDoc && documents.some((document) => document.path === activeDoc) ? (
              <PresetDocumentPanel document={documents.find((document) => document.path === activeDoc)!} />
            ) : (
              <PresetDocumentPanel document={documents[0]!} />
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function IdentityItem({
  label,
  value,
  wide = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly wide?: boolean;
}) {
  return (
    <div className={`min-w-0 border-r border-b border-border/70 px-3 py-2 ${wide ? "sm:col-span-2" : ""}`}>
      <dt className="font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-text-faint">{label}</dt>
      <dd title={value} className="mt-1 min-w-0 truncate font-mono text-[11px] text-text-muted">
        {value}
      </dd>
    </div>
  );
}

function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, index: number, select: (tab: PresetDetailTab) => void) {
  const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  if (direction === 0) return;
  event.preventDefault();
  const next = (index + direction + tabs.length) % tabs.length,
    tab = tabs[next]!;
  select(tab.id);
  event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#preset-tab-${tab.id}`)?.focus();
}
