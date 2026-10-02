import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, useTheme, type ThemeMode } from "../../theme.tsx";
import { AppMotionConfig, useMotionPreference, type MotionPreference } from "../../motion-config.tsx";
import { I18nProvider } from "../../i18n/index.tsx";
import { PageHeader } from "../primitives/PageHeader.tsx";
import { Region } from "../primitives/Region.tsx";
import { DenseRow, RowTime } from "../primitives/DenseRow.tsx";
import { Toggle } from "../primitives/Toggle.tsx";
import { SegCtl } from "../primitives/SegCtl.tsx";
import { StatusTag } from "../primitives/StatusTag.tsx";
import { Tabs } from "../primitives/Tabs.tsx";
import { TabPanel } from "../primitives/EntryBoundary.tsx";
import { Button } from "../primitives/Button.tsx";
import { Empty } from "../primitives/Empty.tsx";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { IdText } from "../IdText.tsx";
import "../../styles.css";

/** Development-only Vite entry: real components, synthetic data, no daemon writes. */
function ComponentCatalog() {
  const { mode, setMode } = useTheme();
  const { preference, setPreference } = useMotionPreference();
  const [narrow, setNarrow] = useState(false);
  const [tab, setTab] = useState<"rows" | "empty">("rows");
  const [selected, setSelected] = useState<string | null>(null);
  const [navigation, setNavigation] = useState("尚未触发导航回调");
  return (
    <main className="h-screen overflow-y-auto bg-bg p-6 text-text sm:p-10" data-testid="component-catalog">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-6 border-b border-border pb-6">
        <div>
          <p className="mb-2 font-mono text-text-faint ui-meta">HARNESS / GUI COMPONENTS</p>
          <PageHeader title="共享组件展示目录" note="真实原语 · 示例数据 · 本页交互" />
        </div>
        <div className="flex flex-wrap items-center gap-4 ui-meta">
          <label className="grid gap-1">
            主题
            <select aria-label="主题" value={mode} onChange={(event) => setMode(event.target.value as ThemeMode)}>
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </label>
          <label className="grid gap-1">
            动效
            <select
              aria-label="动效"
              value={preference}
              onChange={(event) => setPreference(event.target.value as MotionPreference)}
            >
              <option value="system">跟随系统</option>
              <option value="on">开启</option>
              <option value="off">关闭</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={narrow} onChange={(event) => setNarrow(event.target.checked)} />
            窄容器
          </label>
        </div>
      </header>
      <div className="grid gap-10" style={{ maxWidth: narrow ? "24rem" : undefined }} data-testid="catalog-samples">
        <section className="grid gap-3">
          <h2 className="font-semibold ui-title">开关 / Toggle</h2>
          <div className="flex items-center gap-3">
            <Toggle label="窄容器示例" checked={narrow} onChange={setNarrow} /> 窄容器
          </div>
          <div className="flex items-center gap-3">
            <Toggle label="禁用开关" checked disabled /> 禁用
          </div>
          <h2 className="font-semibold ui-title">分段选择 / SegCtl</h2>
          <p className="text-text-muted ui-meta">统一设置、权限和运行时的选择交互；原生按钮支持键盘并避免提交表单。</p>
          <div>
            <SegCtl
              label="目录主题"
              value={mode}
              onChange={setMode}
              options={[
                { value: "system", label: "跟随系统" },
                { value: "light", label: "浅色" },
                { value: "dark", label: "深色" },
              ]}
            />
          </div>
          <div>
            <SegCtl
              disabled
              label="禁用示例"
              value="local"
              onChange={() => {}}
              options={[
                { value: "local", label: "本地" },
                { value: "remote", label: "远程" },
              ]}
            />
          </div>
        </section>
        <section className="grid gap-3">
          <h2 className="font-semibold ui-title">状态 / StatusTag</h2>
          <p className="text-text-muted ui-meta">由同一状态词表和颜色映射渲染，状态文字不能只靠颜色辨认。</p>
          <div className="flex flex-wrap gap-3">
            {(["planned", "active", "submitted", "in_review", "blocked", "done", "cancelled"] as const).map(
              (status) => (
                <StatusTag key={status} status={status} />
              ),
            )}
          </div>
        </section>
        <section className="grid min-w-0 gap-3">
          <h2 className="font-semibold ui-title">按钮 / Button</h2>
          <p className="text-text-muted ui-meta">
            全仓唯一按钮实现:plain / primary / danger / ghost 四档,sm / md 两档;禁用态透明度降低且不可点。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button>次档 plain</Button>
            <Button variant="primary">主档 primary</Button>
            <Button variant="danger">危险 danger</Button>
            <Button variant="ghost">幽灵 ghost</Button>
            <Button size="sm">小档 sm</Button>
            <Button disabled tip="禁用时提示仍可达">
              禁用
            </Button>
          </div>
        </section>
        <section className="grid min-w-0 gap-3">
          <h2 className="font-semibold ui-title">长值与空态 / IdText · Empty</h2>
          <p className="text-text-muted ui-meta">
            无导航落点的长值由 IdText 统一截断与悬停完整值;窄容器下不撑列。Empty 只承载「该有而无」。
          </p>
          <div className="min-w-0">
            <IdText
              value="sha256:9f2c1e77a4b0d83c5e6a1f29b8d4c7e0a3b6d9f2c5e8a1b4d7f0e3c6a9b2d5e8"
              title="构建产物摘要"
            />
          </div>
          <Empty>该工作还没有任何执行记录</Empty>
        </section>
        <section className="grid min-w-0 gap-3">
          <h2 className="font-semibold ui-title">列表与区域 / DenseRow · Region · Tabs</h2>
          <Tabs
            idPrefix="catalog"
            ariaLabel="列表示例"
            value={tab}
            onChange={setTab}
            tabs={[
              { key: "rows", label: "有内容" },
              { key: "empty", label: "空状态" },
            ]}
          />
          <TabPanel idPrefix="catalog" value={tab}>
            <Region title="执行记录" big={tab === "rows" ? 3 : 0}>
              {tab === "empty" ? (
                <p className="p-4 text-text-muted ui-body">尚无执行记录。切回「有内容」查看交互示例。</p>
              ) : (
                <>
                  <DenseRow
                    tag={<StatusTag status="active" />}
                    title="实现组件默认行为"
                    reason="原语内部承担布局约束，调用方传入语义。"
                    relaxed
                    selected={selected === "active"}
                    onClick={() => setSelected("active")}
                  />
                  <DenseRow
                    tag={<StatusTag status="in_review" />}
                    title="检查长标题：这是一段用于验证窄容器中标题收束和层级的示例内容"
                    reason="完整原文保留在悬停内容里。"
                    hoverTitle="检查长标题：这是一段用于验证窄容器中标题收束和层级的示例内容"
                    relaxed
                    selected={selected === "review"}
                    onClick={() => setSelected("review")}
                  />
                  <DenseRow
                    tag={<StatusTag status="done" />}
                    title="定向验证已通过"
                    time={<RowTime at="2026-10-02T01:30:00Z" />}
                    selected={selected === "done"}
                    onClick={() => setSelected("done")}
                  />
                </>
              )}
            </Region>
          </TabPanel>
          <output className="text-text-muted ui-meta" aria-live="polite">
            选中示例：{selected ?? "无"}
          </output>
        </section>
        <section className="grid min-w-0 gap-3">
          <h2 className="font-semibold ui-title">实体引用 / EntityRefLink</h2>
          <p className="text-text-muted ui-meta">展示与完整引用分离；用 Tab 和 Enter 验证导航回调。</p>
          <div>
            <EntityRefLink entityRef="task/catalog-example" onNavigate={setNavigation}>
              组件示例任务
            </EntityRefLink>
          </div>
          <output className="break-all font-mono text-text-muted ui-meta" aria-live="polite">
            {navigation}
          </output>
        </section>
      </div>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Catalog root was not found.");
createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <AppMotionConfig>
        <I18nProvider>
          <ComponentCatalog />
        </I18nProvider>
      </AppMotionConfig>
    </ThemeProvider>
  </StrictMode>,
);
