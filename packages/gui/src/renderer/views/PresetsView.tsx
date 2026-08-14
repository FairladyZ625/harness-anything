import { useEffect, useState } from "react";
import { ArrowClockwise, Stack } from "@phosphor-icons/react";
import { useCatalogPreset, useCatalogReread, useCatalogSnapshot } from "../catalog-data.ts";

type Tab = "presets" | "verticals" | "templates";
const tabs: ReadonlyArray<{ readonly id: Tab; readonly label: string }> = [
  { id: "presets", label: "Presets" }, { id: "verticals", label: "Verticals" }, { id: "templates", label: "Templates / locale" },
];

export function PresetsView({ repoId }: { readonly repoId: string }) {
  const snapshot = useCatalogSnapshot(repoId), data = snapshot.data;
  const [tab, setTab] = useState<Tab>("presets"), [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => { setSelectedId(data?.defaults.presetId ?? data?.presets[0]?.id ?? null); }, [data?.catalogDigest, data?.defaults.presetId, data?.presets]);
  const detail = useCatalogPreset(repoId, selectedId, data?.defaults.locale ?? "unknown");
  const reread = useCatalogReread(repoId, data?.catalogDigest);
  if (snapshot.isPending) return <State text="读取 canonical catalog…" />;
  if (snapshot.isError || !data) return <State danger text={`Catalog 读取失败：${snapshot.error instanceof Error ? snapshot.error.message : "unknown / 未投影"}`} />;
  return <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
    <header className="border-b border-border px-4 py-3"><div className="flex flex-wrap items-center gap-2"><Stack className="text-text-faint"/><h1 className="ui-title font-semibold">Catalog / Preset</h1><span className="font-mono text-[11px] text-text-faint">{repoId} · {data.status} · {data.catalogDigest.slice(0, 18)}…</span><button disabled={reread.isPending} onClick={() => reread.mutate()} className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] text-text-muted hover:border-border-strong disabled:opacity-50"><ArrowClockwise/>重新读取</button></div>
      <p className="mt-1 text-[12px] text-text-faint">安装、卸载与 shadow 作者操作由 CLI 管理。默认 locale：<span className="font-mono text-text-muted">{data.defaults.locale}</span></p>
      {reread.data && <p className={`mt-1 font-mono text-[11px] ${reread.data.ok ? "text-status-done" : "text-status-blocked"}`}>operationId {reread.data.operationId} · {reread.data.outcome} · {reread.data.beforeDigest.slice(0, 14)} → {reread.data.afterDigest.slice(0, 14)}{reread.data.error ? ` · ${reread.data.error.code}: ${reread.data.error.hint}` : ""}</p>}
    </header>
    <div className="flex gap-1 border-b border-border px-4 py-2">{tabs.map((item) => <button key={item.id} onClick={() => setTab(item.id)} className={`rounded-md px-3 py-1 text-[12px] ${tab === item.id ? "bg-surface-raised font-semibold text-text" : "text-text-muted hover:text-text"}`}>{item.label}</button>)}</div>
    <div className="mx-auto grid w-full max-w-6xl gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <section className="min-w-0 space-y-2">
        {tab === "presets" && data.presets.map((preset) => <button key={`${preset.sourceKind}:${preset.id}`} onClick={() => setSelectedId(preset.id)} className={`w-full rounded-lg border p-3 text-left ${selectedId === preset.id ? "border-accent bg-accent/5" : "border-border bg-surface hover:border-border-strong"}`}><div className="flex flex-wrap items-center gap-2"><b className="text-[14px]">{preset.title}</b><code className="text-[11px] text-text-faint">{preset.id}</code><Truth value={preset.sourceKind}/><Truth value={preset.validity}/>{preset.id === data.defaults.presetId && <Truth value="default"/>}</div><p className="mt-1 text-[12px] text-text-muted">{preset.description || "unknown / 未投影"}</p><p className="mt-1 font-mono text-[11px] text-text-faint">vertical {preset.verticalId} · version {preset.version ?? "unknown / 未投影"} · entrypoints {preset.entrypoints.join(", ") || "unknown / 未投影"}</p>{preset.shadows && <p className="mt-1 text-[11px] text-stale">shadow 覆盖 bundled：{preset.shadows.title}</p>}{preset.issues.length > 0 && <pre className="mt-2 overflow-auto whitespace-pre-wrap rounded bg-surface-raised p-2 text-[11px] text-status-blocked">{JSON.stringify(preset.issues, null, 2)}</pre>}</button>)}
        {tab === "verticals" && data.verticals.map((vertical) => <article key={vertical.id} className="rounded-lg border border-border bg-surface p-3"><div className="flex items-center gap-2"><b>{vertical.title}</b><code className="text-[11px] text-text-faint">{vertical.id}@{vertical.version}</code><Truth value={vertical.valid ? "valid" : "invalid"}/><Truth value={vertical.available ? "available" : "unavailable"}/></div><p className="mt-1 font-mono text-[11px] text-text-faint">source {vertical.source}</p>{vertical.issues.length > 0 && <pre className="mt-2 whitespace-pre-wrap text-[11px] text-status-blocked">{JSON.stringify(vertical.issues, null, 2)}</pre>}</article>)}
        {tab === "templates" && data.templates.map((template) => <article key={`${template.slot}:${template.templateRef}`} className="rounded-lg border border-border bg-surface p-3"><b className="text-[13px]">{template.slot}</b><p className="mt-1 break-all font-mono text-[11px] text-text-muted">{template.templateRef} → {template.materializeAs}</p><p className="mt-1 text-[11px] text-text-faint">locale: {template.locales.join(", ") || "unknown / 未投影"} · snapshot default {data.defaults.locale}</p></article>)}
      </section>
      <aside className="h-fit rounded-lg border border-border bg-surface p-3"><h2 className="text-[13px] font-semibold">Resolved preset</h2>{detail.isPending ? <p className="mt-2 text-[12px] text-text-faint">按 {data.defaults.locale} 解析…</p> : detail.isError || !detail.data ? <p className="mt-2 text-[12px] text-status-blocked">unknown / 未投影：{detail.error instanceof Error ? detail.error.message : "未选择 preset"}</p> : <dl className="mt-2 grid gap-2 text-[12px]"><Field name="id" value={detail.data.preset.id}/><Field name="vertical" value={detail.data.preset.verticalId}/><Field name="extends" value={detail.data.preset.extends ?? "none"}/><ShaField name="digest" value={detail.data.resolved.digest}/><Field name="locale" value={data.defaults.locale}/><Field name="capability imports" value={detail.data.preset.capabilityImports.length ? JSON.stringify(detail.data.preset.capabilityImports) : "none"}/><ProvenanceFields provenance={detail.data.resolved.provenance}/></dl>}</aside>
    </div>
  </div>;
}
function Truth({ value }: { readonly value: string }) { return <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-text-muted">{value}</span>; }
function Field({ name, value }: { readonly name: string; readonly value: string }) { return <div><dt className="font-mono text-[10px] uppercase text-text-faint">{name}</dt><dd className="break-all text-text-muted">{value}</dd></div>; }

/** 长哈希一行:截断显示,悬停看全量(title),单击复制。 */
function ShaField({ name, value }: { readonly name: string; readonly value: string }) {
  const [copied, setCopied] = useState(false);
  const short = value.length > 22 ? `${value.slice(0, 14)}…${value.slice(-6)}` : value;
  return (
    <div data-testid="preset-sha-field" data-field={name}>
      <dt className="font-mono text-[10px] uppercase text-text-faint">{name}</dt>
      <dd className="flex min-w-0 items-center gap-1.5">
        <button
          title={value}
          onClick={() => { void navigator.clipboard?.writeText(value).then(() => setCopied(true)); }}
          className="min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left font-mono text-[11px] text-text-muted hover:bg-surface-raised hover:text-text"
        >{short}</button>
        <span className={`shrink-0 font-mono text-[10px] text-status-done ${copied ? "" : "hidden"}`}>已复制</span>
      </dd>
    </div>
  );
}

/** resolved.provenance(preset-snapshot/v1):4 个 sha256 逐字段 + resolverVersion + ancestry 列表 —— 不糊原始 JSON。 */
function ProvenanceFields({ provenance }: { readonly provenance: Readonly<Record<string, unknown>> }) {
  const shaFields: ReadonlyArray<{ readonly name: string; readonly label: string }> = [
    { name: "manifestSha256", label: "provenance.manifestSha256" },
    { name: "packageSha256", label: "provenance.packageSha256" },
    { name: "verticalSha256", label: "provenance.verticalSha256" },
    { name: "templateCatalogSha256", label: "provenance.templateCatalogSha256" },
  ];
  const ancestry = Array.isArray(provenance.ancestry)
    ? provenance.ancestry.filter((item): item is string => typeof item === "string")
    : [];
  return (<>
    {shaFields.map(({ name, label }) => (
      <ShaField key={name} name={label} value={typeof provenance[name] === "string" ? provenance[name] as string : "unknown / 未投影"}/>
    ))}
    <Field name="provenance.resolverVersion" value={typeof provenance.resolverVersion === "string" ? provenance.resolverVersion : "unknown / 未投影"}/>
    <div>
      <dt className="font-mono text-[10px] uppercase text-text-faint">provenance.ancestry</dt>
      <dd className="mt-0.5 flex flex-wrap gap-1" data-testid="preset-ancestry">
        {ancestry.length > 0
          ? ancestry.map((id) => <span key={id} className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-text-muted">{id}</span>)
          : <span className="text-text-faint">none</span>}
      </dd>
    </div>
  </>);
}
function State({ text, danger = false }: { readonly text: string; readonly danger?: boolean }) { return <div className={`p-6 text-[13px] ${danger ? "text-status-blocked" : "text-text-faint"}`}>{text}</div>; }
