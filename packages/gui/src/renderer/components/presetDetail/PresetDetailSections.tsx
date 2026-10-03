import { useState } from "react";
import { DocReader } from "../DocReader.tsx";
import type { CatalogPresetDocument, CatalogPresetRow, CatalogPresetSuccess } from "../../api-client.ts";
import { t } from "../../i18n/index.tsx";
import { DenseRow } from "../primitives/DenseRow.tsx";
import { Region } from "../primitives/Region.tsx";
import { BoardColumn, BoardMain, BoardRegion, BoardSide, RegionBoard } from "../primitives/RegionBoard.tsx";

/**
 * G7 Preset 详情页分区:概况(区域板:元数据、completion gates、capability imports、
 * provenance、模板)与包内容侧栏/正文。数据全部来自 gui-catalog-preset/v1 读面
 * (resolver 单一权威),GUI 不读文件系统。
 */

export type PresetDetailData = CatalogPresetSuccess;

export function PresetBadge({ value, tone = "muted" }: { readonly value: string; readonly tone?: "muted" | "accent" }) {
  return (
    <span
      data-testid="preset-badge"
      className={`rounded border px-1.5 py-0.5 font-mono ui-micro ${
        tone === "accent" ? "border-accent/60 text-accent" : "border-border text-text-muted"
      }`}
    >
      {value}
    </span>
  );
}

/** 长哈希一行:截断显示,悬停看全量(title),单击复制。 */
export function PresetShaField({ name, value }: { readonly name: string; readonly value: string }) {
  const [copied, setCopied] = useState(false);
  const short = value.length > 22 ? `${value.slice(0, 14)}…${value.slice(-6)}` : value;
  return (
    <div data-testid="preset-sha-field" data-field={name}>
      <dt className="font-mono ui-micro uppercase text-text-faint">{name}</dt>
      <dd className="flex min-w-0 items-center gap-1.5">
        <button
          title={value}
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => setCopied(true));
          }}
          className={[
            "min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left font-mono ui-micro text-text-muted",
            "hover:bg-surface-raised hover:text-text",
          ].join(" ")}
        >
          {short}
        </button>
        <span className={`shrink-0 font-mono ui-micro text-status-done ${copied ? "" : "hidden"}`}>
          {t("views.presetsView.copied")}
        </span>
      </dd>
    </div>
  );
}

/** 概况里的长哈希条目:键在第一行,全量值在第二行(放不下省略,悬停看全量),单击复制。 */
function ShaRow({ name, value }: { readonly name: string; readonly value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <DenseRow
      relaxed
      title={name}
      reason={
        <span title={value} className="font-mono">
          {value}
        </span>
      }
      time={copied ? <span className="text-status-done">{t("views.presetsView.copied")}</span> : undefined}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => setCopied(true));
      }}
    />
  );
}

const PROVENANCE_SHA_FIELDS = ["manifestSha256", "packageSha256", "verticalSha256", "templateCatalogSha256"] as const;

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * 概况是区域板(标准 §2.1):两列主区(清单元数据 + 完成门 | 能力导入 + 来源链),条目最多的
 * 「模板」在最右一列并区内滚动。Preset 没有事件可排,最右列放的是普通区域。键值字段与
 * 名称列表都是 DenseRow;没有内容的区域不渲染。
 */
export function PresetOverviewTab({
  detail,
  row,
  locale,
}: {
  readonly detail: PresetDetailData;
  readonly row: CatalogPresetRow | null;
  readonly locale: string;
}) {
  const none = t("views.presetsView.none"),
    unknown = t("views.presetsView.unknownNotProjected"),
    profile = detail.resolved.profile,
    gates = Array.isArray(profile.completionGateIds)
      ? profile.completionGateIds.filter((item): item is string => typeof item === "string")
      : [],
    imports = detail.preset.capabilityImports,
    provenance = detail.resolved.provenance,
    ancestry = Array.isArray(provenance.ancestry)
      ? provenance.ancestry.filter((item): item is string => typeof item === "string")
      : [],
    templates = detail.resolved.templates,
    entrypoints = detail.resolved.entrypoints.filter((item): item is string => typeof item === "string");
  return (
    <RegionBoard data-testid="preset-overview-tab">
      <BoardMain>
        <BoardColumn>
          <BoardRegion region="manifest">
            <Region title={t("views.presetDetailView.overviewManifest")}>
              {row?.description ? (
                <p className="px-3.5 pb-2 ui-meta leading-5 text-text-muted">{row.description}</p>
              ) : null}
              <DenseRow title="id" time={detail.preset.id} />
              <DenseRow title={t("views.presetsView.vertical")} time={detail.preset.verticalId} />
              <DenseRow title="extends" time={detail.preset.extends ?? none} />
              <DenseRow title={t("views.presetsView.version")} time={detail.preset.version ?? none} />
              <DenseRow title={t("views.presetsView.locale")} time={locale} />
              {entrypoints.length > 0 ? (
                <DenseRow relaxed title={t("views.presetsView.entrypoints")} reason={entrypoints.join(", ")} />
              ) : (
                <DenseRow title={t("views.presetsView.entrypoints")} time={none} />
              )}
              {row?.kind ? <DenseRow title="kind" time={row.kind} /> : null}
              <DenseRow title="defaultProfile" time={row?.defaultProfile ?? none} />
              <ShaRow name="digest" value={detail.resolved.digest} />
            </Region>
          </BoardRegion>
          {gates.length > 0 ? (
            <BoardRegion region="gates">
              <Region
                title={t("views.presetDetailView.overviewProfile")}
                footer={t("views.presetDetailView.completionGatesDescription")}
              >
                {gates.map((gate) => (
                  <DenseRow key={gate} title={gate} />
                ))}
              </Region>
            </BoardRegion>
          ) : null}
        </BoardColumn>
        <BoardColumn>
          {imports.length > 0 ? (
            <BoardRegion region="imports">
              <Region title={t("views.presetsView.capabilityImports")}>
                {imports.map((item, index) => {
                  if (item === null || typeof item !== "object" || Array.isArray(item))
                    return <DenseRow key={index} title={JSON.stringify(item)} />;
                  const record = item as Record<string, unknown>;
                  return (
                    <DenseRow
                      key={index}
                      relaxed
                      title={text(record.id, "?")}
                      reason={`${text(record.kind, "?")}@${text(record.version, "?")}`}
                    />
                  );
                })}
              </Region>
            </BoardRegion>
          ) : null}
          <BoardRegion region="provenance">
            <Region title={t("views.presetDetailView.overviewProvenance")}>
              {PROVENANCE_SHA_FIELDS.map((name) => (
                <ShaRow key={name} name={`provenance.${name}`} value={text(provenance[name], unknown)} />
              ))}
              <DenseRow title="provenance.resolverVersion" time={text(provenance.resolverVersion, unknown)} />
              {ancestry.map((id, index) => (
                <DenseRow
                  key={id}
                  relaxed
                  title={id}
                  reason={`${t("views.presetsView.provenanceAncestry")} ${index + 1}/${ancestry.length}`}
                />
              ))}
            </Region>
          </BoardRegion>
        </BoardColumn>
      </BoardMain>
      {templates.length > 0 ? (
        <BoardSide region="templates" data-testid="preset-overview-templates">
          <Region
            title={t("views.presetsView.templatesTab")}
            footer={t("views.presetDetailView.templatesDescription", { count: String(templates.length) })}
          >
            {templates.map((template, index) => {
              const record = template as Record<string, unknown>;
              return (
                <DenseRow
                  key={index}
                  relaxed
                  title={text(record.slot, `#${index + 1}`)}
                  reason={text(record.path, unknown)}
                  time={`${text(record.owner, unknown)} · ${text(record.locale, unknown)}`}
                />
              );
            })}
          </Region>
        </BoardSide>
      ) : null}
    </RegionBoard>
  );
}

/** 包内容侧栏:resolver documents 的 slot 清单(G7 详情页文件树)。 */
export function PresetDocumentSidebar({
  documents,
  activeDoc,
  onOpenDoc,
}: {
  readonly documents: readonly CatalogPresetDocument[];
  readonly activeDoc: string;
  readonly onOpenDoc: (path: string) => void;
}) {
  return (
    <nav
      aria-label={t("views.presetDetailView.packageDocuments")}
      className={[
        "min-h-0 overflow-y-auto border-b border-border bg-surface p-3",
        "@max-[1100px]:max-h-[var(--long-content-cap)] @min-[1100px]:border-r @min-[1100px]:border-b-0",
      ].join(" ")}
      data-testid="preset-document-sidebar"
    >
      <p className="mb-2 px-1 font-mono ui-micro font-semibold uppercase tracking-[0.16em] text-text-faint">
        {t("views.presetDetailView.packageDocuments")}
      </p>
      {documents.length === 0 ? (
        <p className="border border-dashed border-border px-2 py-3 ui-meta leading-5 text-text-faint">
          {t("views.presetDetailView.noDocuments")}
        </p>
      ) : (
        <ul className="grid gap-0.5">
          {documents.map((document) => {
            const active = document.path === activeDoc;
            return (
              <li key={document.path}>
                <button
                  type="button"
                  onClick={() => onOpenDoc(document.path)}
                  aria-current={active ? "true" : undefined}
                  className={[
                    "w-full rounded-md px-2 py-1.5 text-left",
                    active ? "bg-accent/10 text-text" : "text-text-muted hover:bg-surface-raised hover:text-text",
                  ].join(" ")}
                >
                  <span className="block truncate font-mono ui-micro">{document.slot}</span>
                  <span className="block truncate font-mono ui-micro text-text-faint">{document.path}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}

/** 包内容正文:markdown 走 DocReader,纯文本按原样呈现。 */
export function PresetDocumentPanel({ document }: { readonly document: CatalogPresetDocument }) {
  return (
    <section className="min-w-0" data-testid="preset-document-panel">
      <div className="mb-4 flex flex-wrap items-center gap-1.5 border-b border-border pb-3">
        <span className="font-mono ui-micro text-text-faint">{document.slot}</span>
        <span className="font-mono ui-micro text-text-faint">→</span>
        <span className="font-mono ui-micro text-text-muted">{document.path}</span>
        <PresetBadge value={document.templateRef} />
        <PresetBadge value={document.mediaType} />
        <PresetBadge value={`${t("views.presetDetailView.owner")}: ${document.owner}`} />
      </div>
      {document.mediaType === "text/markdown" ? (
        <DocReader content={document.body} />
      ) : (
        <pre
          className={[
            "overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface p-4",
            "font-mono ui-meta leading-5 text-text-muted",
          ].join(" ")}
        >
          {document.body}
        </pre>
      )}
    </section>
  );
}
