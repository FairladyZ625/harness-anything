import { useState } from "react";
import { DocReader } from "../DocReader.tsx";
import type { CatalogPresetDocument, CatalogPresetRow, CatalogPresetSuccess } from "../../api-client.ts";
import { t } from "../../i18n/index.tsx";

/**
 * G7 Preset 详情页分区:概况(元数据 + capability imports + completion gates +
 * provenance)与包内容侧栏/正文。数据全部来自 gui-catalog-preset/v1 读面
 * (resolver 单一权威),GUI 不读文件系统。
 */

export type PresetDetailData = CatalogPresetSuccess;

export function PresetBadge({ value, tone = "muted" }: { readonly value: string; readonly tone?: "muted" | "accent" }) {
  return (
    <span
      data-testid="preset-badge"
      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
        tone === "accent" ? "border-accent/60 text-accent" : "border-border text-text-muted"
      }`}
    >
      {value}
    </span>
  );
}

export function PresetMetaField({ name, value }: { readonly name: string; readonly value: string }) {
  return (
    <div data-testid="preset-meta-field">
      <dt className="font-mono text-[10px] uppercase text-text-faint">{name}</dt>
      <dd className="break-all text-text-muted">{value}</dd>
    </div>
  );
}

/** 长哈希一行:截断显示,悬停看全量(title),单击复制。 */
export function PresetShaField({ name, value }: { readonly name: string; readonly value: string }) {
  const [copied, setCopied] = useState(false);
  const short = value.length > 22 ? `${value.slice(0, 14)}…${value.slice(-6)}` : value;
  return (
    <div data-testid="preset-sha-field" data-field={name}>
      <dt className="font-mono text-[10px] uppercase text-text-faint">{name}</dt>
      <dd className="flex min-w-0 items-center gap-1.5">
        <button
          title={value}
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => setCopied(true));
          }}
          className={[
            "min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left font-mono text-[11px] text-text-muted",
            "hover:bg-surface-raised hover:text-text",
          ].join(" ")}
        >
          {short}
        </button>
        <span className={`shrink-0 font-mono text-[10px] text-status-done ${copied ? "" : "hidden"}`}>
          {t("views.presetsView.copied")}
        </span>
      </dd>
    </div>
  );
}

/** resolved.provenance(preset-snapshot/v1):4 个 sha256 逐字段 + resolverVersion + ancestry 列表。 */
export function PresetProvenanceFields({ provenance }: { readonly provenance: Readonly<Record<string, unknown>> }) {
  const shaFields: ReadonlyArray<{ readonly name: string; readonly label: string }> = [
    { name: "manifestSha256", label: "provenance.manifestSha256" },
    { name: "packageSha256", label: "provenance.packageSha256" },
    { name: "verticalSha256", label: "provenance.verticalSha256" },
    { name: "templateCatalogSha256", label: "provenance.templateCatalogSha256" },
  ];
  const ancestry = Array.isArray(provenance.ancestry)
    ? provenance.ancestry.filter((item): item is string => typeof item === "string")
    : [];
  return (
    <>
      {shaFields.map(({ name, label }) => (
        <PresetShaField
          key={name}
          name={label}
          value={
            typeof provenance[name] === "string"
              ? (provenance[name] as string)
              : t("views.presetsView.unknownNotProjected")
          }
        />
      ))}
      <PresetMetaField
        name="provenance.resolverVersion"
        value={
          typeof provenance.resolverVersion === "string"
            ? provenance.resolverVersion
            : t("views.presetsView.unknownNotProjected")
        }
      />
      <div>
        <dt className="font-mono text-[10px] uppercase text-text-faint">{t("views.presetsView.provenanceAncestry")}</dt>
        <dd className="mt-0.5 flex flex-wrap gap-1" data-testid="preset-ancestry">
          {ancestry.length > 0 ? (
            ancestry.map((id) => (
              <span
                key={id}
                className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-text-muted"
              >
                {id}
              </span>
            ))
          ) : (
            <span className="text-text-faint">{t("views.presetsView.none")}</span>
          )}
        </dd>
      </div>
    </>
  );
}

function capabilityImportRow(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const row = value as Record<string, unknown>,
      id = typeof row.id === "string" ? row.id : "?",
      kind = typeof row.kind === "string" ? row.kind : "?",
      version = typeof row.version === "string" ? row.version : "?";
    return `${id} · ${kind}@${version}`;
  }
  return JSON.stringify(value);
}

function completionGateIds(profile: Readonly<Record<string, unknown>>): readonly string[] {
  return Array.isArray(profile.completionGateIds)
    ? profile.completionGateIds.filter((item): item is string => typeof item === "string")
    : [];
}

function SectionHeading({
  eyebrow,
  title,
  description,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly description?: string;
}) {
  return (
    <header>
      <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-text-faint">{eyebrow}</p>
      <h2 className="mt-0.5 text-[15px] font-semibold leading-5 text-text">{title}</h2>
      {description ? <p className="mt-1 text-[12px] leading-5 text-text-muted">{description}</p> : null}
    </header>
  );
}

export function PresetOverviewTab({
  detail,
  row,
  locale,
}: {
  readonly detail: PresetDetailData;
  readonly row: CatalogPresetRow | null;
  readonly locale: string;
}) {
  const gates = completionGateIds(detail.resolved.profile),
    imports = detail.preset.capabilityImports,
    templates = detail.resolved.templates;
  return (
    <div className="grid gap-8" data-testid="preset-overview-tab">
      <section className="min-w-0">
        <SectionHeading
          eyebrow="MANIFEST"
          title={t("views.presetDetailView.overviewManifest")}
          description={row?.description ?? t("views.presetsView.unknownNotProjected")}
        />
        <dl className="mt-4 grid gap-3 text-[12px] sm:grid-cols-2 xl:grid-cols-3" data-testid="preset-manifest-fields">
          <PresetMetaField name="id" value={detail.preset.id} />
          <PresetMetaField name={t("views.presetsView.vertical")} value={detail.preset.verticalId} />
          <PresetMetaField name="extends" value={detail.preset.extends ?? t("views.presetsView.none")} />
          <PresetMetaField
            name={t("views.presetsView.version")}
            value={detail.preset.version ?? t("views.presetsView.none")}
          />
          <PresetMetaField name={t("views.presetsView.locale")} value={locale} />
          <PresetMetaField
            name={t("views.presetsView.entrypoints")}
            value={
              detail.resolved.entrypoints.filter((item): item is string => typeof item === "string").join(", ") ||
              t("views.presetsView.none")
            }
          />
          {row?.kind ? <PresetMetaField name="kind" value={row.kind} /> : null}
          {row?.defaultProfile ? (
            <PresetMetaField name="defaultProfile" value={row.defaultProfile} />
          ) : (
            <PresetMetaField name="defaultProfile" value={t("views.presetsView.none")} />
          )}
          <PresetShaField name="digest" value={detail.resolved.digest} />
        </dl>
      </section>

      <section className="min-w-0">
        <SectionHeading
          eyebrow="PROFILE"
          title={t("views.presetDetailView.overviewProfile")}
          description={t("views.presetDetailView.completionGatesDescription")}
        />
        <div className="mt-3 flex flex-wrap gap-1.5" data-testid="preset-completion-gates">
          {gates.length > 0 ? (
            gates.map((gate) => <PresetBadge key={gate} value={gate} tone="accent" />)
          ) : (
            <span className="text-[12px] text-text-faint">{t("views.presetsView.none")}</span>
          )}
        </div>
      </section>

      <section className="min-w-0">
        <SectionHeading
          eyebrow="CAPABILITY IMPORTS"
          title={t("views.presetsView.capabilityImports")}
          description={t("views.presetDetailView.capabilityImportsDescription")}
        />
        <div className="mt-3 flex flex-wrap gap-1.5" data-testid="preset-capability-imports">
          {imports.length > 0 ? (
            imports.map((item, index) => <PresetBadge key={index} value={capabilityImportRow(item)} />)
          ) : (
            <span className="text-[12px] text-text-faint">{t("views.presetsView.none")}</span>
          )}
        </div>
      </section>

      <section className="min-w-0">
        <SectionHeading
          eyebrow="PROVENANCE"
          title={t("views.presetDetailView.overviewProvenance")}
          description={t("views.presetDetailView.provenanceDescription")}
        />
        <dl
          className="mt-4 grid gap-3 text-[12px] sm:grid-cols-2 xl:grid-cols-3"
          data-testid="preset-provenance-fields"
        >
          <PresetProvenanceFields provenance={detail.resolved.provenance} />
        </dl>
      </section>

      <section className="min-w-0">
        <SectionHeading
          eyebrow="TEMPLATES"
          title={t("views.presetsView.templatesTab")}
          description={t("views.presetDetailView.templatesDescription", { count: String(templates.length) })}
        />
        <dl className="mt-4 grid gap-3 text-[12px] sm:grid-cols-2 xl:grid-cols-3" data-testid="preset-template-fields">
          {templates.map((template, index) => {
            const record = template as Record<string, unknown>,
              slot = typeof record.slot === "string" ? record.slot : `#${index + 1}`,
              path = typeof record.path === "string" ? record.path : t("views.presetsView.unknownNotProjected"),
              owner = typeof record.owner === "string" ? record.owner : t("views.presetsView.unknownNotProjected"),
              templateLocale =
                typeof record.locale === "string" ? record.locale : t("views.presetsView.unknownNotProjected");
            return (
              <div key={`${slot}:${index}`} className="rounded-lg border border-border bg-surface p-3">
                <b className="font-mono text-[12px] text-text">{slot}</b>
                <p className="mt-1 break-all font-mono text-[11px] text-text-muted">{path}</p>
                <p className="mt-1 font-mono text-[10px] text-text-faint">
                  {owner} · {templateLocale}
                </p>
              </div>
            );
          })}
          {templates.length === 0 ? (
            <span className="text-[12px] text-text-faint">{t("views.presetsView.none")}</span>
          ) : null}
        </dl>
      </section>
    </div>
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
        "@max-[1100px]:max-h-72 @min-[1100px]:border-r @min-[1100px]:border-b-0",
      ].join(" ")}
      data-testid="preset-document-sidebar"
    >
      <p className="mb-2 px-1 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-text-faint">
        {t("views.presetDetailView.packageDocuments")}
      </p>
      {documents.length === 0 ? (
        <p className="border border-dashed border-border px-2 py-3 text-[12px] leading-5 text-text-faint">
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
                  <span className="block truncate font-mono text-[11px]">{document.slot}</span>
                  <span className="block truncate font-mono text-[10px] text-text-faint">{document.path}</span>
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
        <span className="font-mono text-[11px] text-text-faint">{document.slot}</span>
        <span className="font-mono text-[10px] text-text-faint">→</span>
        <span className="font-mono text-[11px] text-text-muted">{document.path}</span>
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
            "font-mono text-[12px] leading-5 text-text-muted",
          ].join(" ")}
        >
          {document.body}
        </pre>
      )}
    </section>
  );
}
