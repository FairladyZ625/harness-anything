import { useEffect, useState } from "react";
import { Stack } from "@phosphor-icons/react";
import type { Project } from "../model/types";
import type { CatalogRendererData } from "../catalog-data";
import { SOURCE_SECTIONS, TABS, type TabId } from "../components/preset/shared";
import { ConceptBar } from "../components/preset/ConceptBar";
import { PresetCard } from "../components/preset/PresetCard";
import { VerticalCard, TemplateCard } from "../components/preset/VerticalAndTemplateCards";
import { PresetContextRail } from "../components/preset/PresetContextRail";

export function PresetsView({
  catalog,
  project,
  loading,
  failed,
}: {
  catalog: CatalogRendererData | undefined;
  project: Project;
  loading: boolean;
  failed: boolean;
}) {
  const presets = catalog?.presets ?? [];
  const verticals = catalog?.verticals ?? [];
  const templates = catalog?.templates ?? [];
  const [tab, setTab] = useState<TabId>("preset");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);
  const activePreset = presets.find((p) => p.id === project.preset) ?? presets[0];
  const focusedPreset =
    presets.find((p) => p.id === (expandedId ?? project.preset)) ?? activePreset;

  const jumpToPreset = (id: string) => {
    setTab("preset");
    setExpandedId(id);
    setScrollTarget(id);
  };

  useEffect(() => {
    if (tab === "preset" && scrollTarget) {
      document
        .getElementById(`preset-${scrollTarget}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      setScrollTarget(null);
    }
  }, [tab, scrollTarget]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <Stack className="self-center text-[15px] text-text-faint" />
          <h1 className="ui-title font-semibold">Preset / Vertical 管理</h1>
          <span className="shrink-0 font-mono text-[11px] text-accent sm:ml-auto">
            当前项目激活：{project.preset}
          </span>
        </div>
        <p className="mt-0.5 text-[11px] text-text-faint">
          当前运行时只提供 software/coding 内置 vertical；custom vertical 尚未实现。
          Preset 列表由 daemon 按 project &gt; user &gt; builtin 解析。
        </p>
      </header>

      {loading && <p className="p-4 text-sm text-text-muted">正在读取 catalog snapshot…</p>}
      {failed && <p className="p-4 text-sm text-danger">catalog snapshot 读取失败。</p>}

      {!loading && !failed && <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section className="flex min-w-0 flex-col gap-4">
          <ConceptBar />

          <div className="flex w-fit items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`rounded-md px-3 py-1 text-[12px] ${
                  tab === t.id
                    ? "bg-surface-raised font-semibold text-text"
                    : "text-text-muted hover:text-text"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === "preset" && (
            <>
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
                <span className="font-mono text-[11px]">project</span>
                <span className="font-mono text-[11px] text-text-faint">&gt;</span>
                <span className="font-mono text-[11px]">user</span>
                <span className="font-mono text-[11px] text-text-faint">&gt;</span>
                <span className="font-mono text-[11px]">builtin</span>
                <span className="min-w-[14rem] flex-1 text-[11px] text-text-muted">
                  · 高优先级来源的同名条目覆盖低优先级；被覆盖项保留但不参与物化
                </span>
              </div>

              {SOURCE_SECTIONS.map(({ source, label, hint }) => {
                const rows = presets.filter((p) => p.source === source);
                return (
                  <section key={source} className="flex flex-col gap-1.5">
                    <div className="flex items-baseline gap-2 px-0.5">
                      <span className="font-mono text-[10px] uppercase tracking-wide text-text-faint">
                        {label}
                      </span>
                      <span className="text-[10px] text-text-faint">{hint}</span>
                    </div>
                    {rows.map((p) => (
                      <PresetCard
                        key={p.id}
                        entry={p}
                        all={presets}
                        active={p.id === project.preset}
                        expanded={expandedId === p.id}
                        onToggle={() => setExpandedId((cur) => (cur === p.id ? null : p.id))}
                        onJump={jumpToPreset}
                      />
                    ))}
                    {rows.length === 0 && (
                      <p className="px-0.5 text-[11px] text-text-faint">该层级暂无条目</p>
                    )}
                  </section>
                );
              })}
            </>
          )}

          {tab === "vertical" && (
            <div className="flex flex-col gap-2">
              <p className="rounded-lg border border-border bg-surface px-3 py-2 text-[11px] text-text-muted">
                当前只有一个内置 vertical；此处是运行时定义检查面，不是多选选择器。
              </p>
              {verticals.map((v) => (
                <VerticalCard key={v.id} v={v} />
              ))}
            </div>
          )}

          {tab === "templates" && (
            <div className="flex flex-col gap-2">
              <p className="px-0.5 text-[11px] text-text-muted">
                侧挂素材库：存正文与 locale variants，被 Vertical/Preset 选择
              </p>
              {templates.map((t) => (
                <TemplateCard key={t.ref} t={t} onJumpToPreset={jumpToPreset} />
              ))}
            </div>
          )}
        </section>

        {activePreset && focusedPreset && (
          <PresetContextRail
            activePreset={activePreset}
            focusedPreset={focusedPreset}
            all={presets}
            verticals={verticals}
            templates={templates}
            tab={tab}
          />
        )}
      </div>
      }
    </div>
  );
}
