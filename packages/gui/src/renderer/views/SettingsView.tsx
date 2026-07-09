import { useState } from "react";
import { ArrowsClockwise, CloudSlash } from "@phosphor-icons/react";
import { useTheme, type ThemeMode, type UiScale } from "../theme";
import { STATUS_META } from "../components/badges";
import { BTN, Section, Row, Segmented, Toggle, Kbd } from "../components/ui/widgets";
import { useRebuildGovernanceMutation } from "../task-data";

const THEME_OPTIONS: { key: ThemeMode; label: string }[] = [
  { key: "dark", label: "暗色" },
  { key: "light", label: "亮色" },
  { key: "system", label: "跟随系统" },
];

const SCALE_OPTIONS: { key: UiScale; label: string }[] = [
  { key: "compact", label: "紧凑" },
  { key: "standard", label: "标准" },
  { key: "comfortable", label: "宽松" },
];

// 已实现的快捷键(其余 ⌘K/⌘1..5/R/X 暂未实现,已从此清单移除以免假承诺)。
const SHORTCUTS: { keys: string[]; desc: string }[] = [
  { keys: ["Esc"], desc: "关闭预览抽屉" },
  { keys: ["Enter"], desc: "在列表中打开任务详情" },
];

type SettingsTab =
  | "appearance"
  | "language"
  | "shortcuts"
  | "notifications"
  | "data"
  | "terminal"
  | "privacy"
  | "sync";

const SETTINGS_TABS: { id: SettingsTab; label: string; desc: string }[] = [
  { id: "appearance", label: "外观", desc: "主题与状态色" },
  { id: "language", label: "语言", desc: "界面文案" },
  { id: "shortcuts", label: "快捷键", desc: "全局操作" },
  { id: "notifications", label: "通知", desc: "封存就绪提醒" },
  { id: "data", label: "数据", desc: "缓存与投影" },
  { id: "terminal", label: "终端", desc: "shell 偏好" },
  { id: "privacy", label: "隐私", desc: "本地默认" },
  { id: "sync", label: "账号与同步", desc: "V2 能力" },
];

export function SettingsView() {
  const { mode, setMode, uiScale, setUiScale } = useTheme();
  const [activeTab, setActiveTab] = useState<SettingsTab>("appearance");
  const [language, setLanguage] = useState<"zh" | "en">("zh");
  const [notifyOnReady, setNotifyOnReady] = useState(true);
  // 重建投影 = 重读本地投影缓存(路径A:hook 已就绪,底层只 queryTaskProjection 不写盘重算)。
  const rebuildMutation = useRebuildGovernanceMutation();

  const renderActivePanel = () => {
    switch (activeTab) {
      case "appearance":
        return (
          <Section title="外观">
            <Row
              label="主题"
              desc="OKLch 双主题 · 六态状态色两主题可辨识度等价"
            >
              <Segmented value={mode} options={THEME_OPTIONS} onChange={setMode} />
            </Row>
            <Row
              label="界面缩放"
              desc="按比例调整正文、标题、泳道和控件密度"
            >
              <Segmented
                value={uiScale}
                options={SCALE_OPTIONS}
                onChange={setUiScale}
              />
            </Row>
            <Row label="状态色" desc="随主题切换实时变色">
              <div className="flex flex-wrap items-center justify-end gap-3">
                {Object.entries(STATUS_META).map(([key, meta]) => (
                  <span key={key} className="inline-flex items-center gap-1">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ background: meta.color }}
                    />
                    <span className="font-mono text-[12px] text-text-muted">
                      {meta.label}
                    </span>
                  </span>
                ))}
              </div>
            </Row>
          </Section>
        );
      case "language":
        return (
          <Section title="语言">
            <Row label="界面语言" desc="多语言切换将在 V2 提供(coming soon)">
              <Segmented
                value={language}
                options={[
                  { key: "zh", label: "中文" },
                  { key: "en", label: "English" },
                ]}
                onChange={setLanguage}
                disabled
              />
            </Row>
          </Section>
        );
      case "shortcuts":
        return (
          <Section
            title="快捷键"
            action={
              <button disabled title="原型暂不支持" className={BTN}>
                重绑定
              </button>
            }
          >
            {SHORTCUTS.map((s) => (
              <div
                key={s.desc}
                className="flex items-center gap-3 border-b border-border px-3 py-1.5 last:border-b-0"
              >
                <span className="flex w-28 shrink-0 items-center gap-1">
                  {s.keys.map((k, i) => (
                    <span key={k} className="inline-flex items-center gap-1">
                      {i > 0 && (
                        <span className="text-[10px] text-text-faint">–</span>
                      )}
                      <Kbd>{k}</Kbd>
                    </span>
                  ))}
                </span>
                <span className="ui-meta text-text-muted">{s.desc}</span>
              </div>
            ))}
          </Section>
        );
      case "notifications":
        return (
          <Section title="通知">
            <Row
              label="封存就绪桌面通知"
              desc="closeoutReadiness=ready 时发送桌面通知（Electron Notification API 尚未接入,coming soon）"
            >
              <Toggle checked={notifyOnReady} onChange={setNotifyOnReady} disabled />
            </Row>
          </Section>
        );
      case "data":
        return (
          <Section title="数据">
            <Row label="缓存目录" desc="本地投影缓存（SQLite）">
              <span className="max-w-full break-all font-mono text-[11px] text-text-muted">
                ~/.harness/cache/projections.db
              </span>
            </Row>
            <Row label="重建投影" desc="重读本地投影缓存(不重算,不写盘)">
              {rebuildMutation.isError && (
                <span className="ui-meta text-danger">
                  重读失败:{(rebuildMutation.error as Error)?.message ?? "桥未返回"}
                </span>
              )}
              {rebuildMutation.isPending && (
                <span className="ui-meta text-accent">重读中…</span>
              )}
              <button
                onClick={() => rebuildMutation.mutate()}
                disabled={rebuildMutation.isPending}
                className={BTN}
              >
                <span className="inline-flex items-center gap-1">
                  <ArrowsClockwise weight="bold" className="text-[12px]" />
                  重读投影
                </span>
              </button>
            </Row>
            <Row label="导出诊断信息" desc="打包日志与投影快照用于排查">
              <button disabled title="原型暂不支持" className={BTN}>
                导出
              </button>
            </Row>
          </Section>
        );
      case "terminal":
        return (
          <Section title="终端">
            <Row label="默认 shell">
              <span className="font-mono text-[13px] text-text-muted">
                /bin/zsh
              </span>
            </Row>
            <Row label="字体">
              <span className="font-mono text-[13px] text-text-muted">
                Geist Mono
              </span>
            </Row>
            <Row label="字号">
              <span className="font-mono text-[13px] text-text-muted">15</span>
            </Row>
          </Section>
        );
      case "privacy":
        return (
          <Section title="隐私">
            <Row label="遥测" desc="默认关闭 · 原型不收集任何数据">
              <Toggle checked={false} disabled />
            </Row>
          </Section>
        );
      case "sync":
        return (
          <Section title="账号与同步">
            <div className="flex items-center gap-3 border-b border-border px-3 py-2.5">
              <CloudSlash
                weight="duotone"
                className="shrink-0 text-xl text-text-faint"
              />
              <p className="ui-meta min-w-0 flex-1 text-text-muted">
                本地模式 · 多端同步与账号体系将在 V2 提供（商业版）
              </p>
              <button disabled title="V2 提供" className={BTN}>
                登录
              </button>
            </div>
            {["多设备同步", "远程项目访问", "手机端审阅"].map((f) => (
              <div
                key={f}
                className="ui-meta flex items-center gap-2 border-b border-border px-3 py-1.5 text-text-faint last:border-b-0"
              >
                <span className="font-mono text-[12px]">·</span>
                {f}
              </div>
            ))}
          </Section>
        );
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <header className="border-b border-border px-4 py-3">
        <h1 className="ui-title font-mono font-semibold">设置</h1>
        <p className="ui-meta mt-0.5 text-text-faint">
          应用偏好 · 原型内除主题外多数项为本地模拟，不会写入磁盘。
        </p>
      </header>

      <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-4 p-4 lg:grid-cols-[12rem_minmax(0,1fr)]">
        <nav className="flex gap-1 overflow-x-auto rounded-lg border border-border bg-surface p-1 lg:flex-col lg:overflow-visible">
          {SETTINGS_TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex shrink-0 flex-col rounded-md px-2.5 py-2 text-left ${
                activeTab === tab.id
                  ? "bg-surface-raised text-text"
                  : "text-text-muted hover:bg-surface-raised/50 hover:text-text"
              }`}
            >
              <span className="text-[14px] font-semibold">{tab.label}</span>
              <span className="mt-0.5 hidden text-[12px] text-text-faint lg:block">
                {tab.desc}
              </span>
            </button>
          ))}
        </nav>

        <div className="min-w-0">{renderActivePanel()}</div>
      </div>
    </div>
  );
}
