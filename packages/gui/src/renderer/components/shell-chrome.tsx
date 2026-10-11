import { Sun, Moon, Desktop } from "@phosphor-icons/react";
import { useTheme, type ThemeMode } from "../theme.tsx";

const THEME_CYCLE: Record<ThemeMode, ThemeMode> = {
  dark: "light",
  light: "system",
  system: "dark",
};

const THEME_ICON: Record<ThemeMode, React.ReactNode> = {
  dark: <Moon weight="duotone" />,
  light: <Sun weight="duotone" />,
  system: <Desktop weight="duotone" />,
};

export function ThemeToggle() {
  const { mode, setMode } = useTheme();
  return (
    <button
      onClick={() => setMode(THEME_CYCLE[mode])}
      title={`主题：${mode}（点击切换）`}
      className="grid size-6 place-items-center rounded text-text-faint hover:bg-surface-raised hover:text-text"
    >
      {THEME_ICON[mode]}
    </button>
  );
}

export function NavButton({
  active,
  onClick,
  icon,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      // 导航字号与内容区正文同档(评审第 6 条:导航文字曾比正文还大,与右侧页面不成比例)。
      className={`flex min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left ui-body leading-snug transition-colors duration-100 ${
        active
          ? "bg-surface-raised font-medium text-text"
          : "text-text-muted hover:bg-surface-raised/60 hover:text-text"
      }`}
    >
      <span className="shrink-0 text-base">{icon}</span>
      <span className="min-w-0 truncate">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="ml-auto shrink-0 rounded bg-accent px-1.5 font-mono ui-micro font-semibold tabular-nums text-accent-fg">
          {badge}
        </span>
      )}
    </button>
  );
}
