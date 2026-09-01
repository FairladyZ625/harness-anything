import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { t } from "../../i18n/index.tsx";

export interface TerminalTaskOption {
  readonly taskId: string;
  readonly title: string;
}

/** 一次最多列多少条;超过就提示继续输入缩小范围,几千个 task 不进 DOM。 */
const listLimit = 40;

/**
 * task 绑定选择器:可检索 combobox,取代原来的 <select>(几千个 task 的下拉不可用)。
 *
 * - 关闭态显示当前绑定的 task 标题(没绑定显示占位),点/聚焦即打开并以输入内容过滤
 *   (标题 + taskId 子串,大小写不敏感)。
 * - 列表首项永远是「不绑定」;↑/↓ 移动,Enter 选中,Esc 关闭;点选用 mousedown
 *   防止 input 先失焦把列表收起。
 */
export function TerminalTaskPicker({
  tasks,
  value,
  onChange,
}: {
  readonly tasks: readonly TerminalTaskOption[];
  readonly value: string;
  readonly onChange: (taskId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = useMemo(() => tasks.find((task) => task.taskId === value) ?? null, [tasks, value]);
  const matches = useMemo(() => filterTasks(tasks, query), [tasks, query]);
  const shown = matches.slice(0, listLimit);
  useEffect(() => setActive(0), [query, open]);

  const pick = (taskId: string) => {
    onChange(taskId);
    setOpen(false);
    setQuery("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "Enter") setOpen(true);
      return;
    }
    if (event.key === "Escape") setOpen(false);
    else if (event.key === "ArrowDown") setActive((index) => Math.min(index + 1, shown.length));
    else if (event.key === "ArrowUp") setActive((index) => Math.max(index - 1, 0));
    else if (event.key === "Enter") pick(active === 0 ? "" : (shown[active - 1]?.taskId ?? ""));
    else return;
    event.preventDefault();
  };
  const optionClassName = (index: number) =>
    `flex w-full flex-col items-start rounded px-2 py-1 text-left ${index === active ? "bg-surface" : ""}`;

  return (
    <div className="relative">
      <input
        ref={inputRef}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls="terminal-task-picker-list"
        data-testid="terminal-task-picker"
        value={open ? query : (selected?.title ?? "")}
        placeholder={open ? t("terminal.view.taskPickerPlaceholder") : t("terminal.view.unbound")}
        title={selected?.taskId}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        className="control w-56"
      />
      {open && (
        <div
          id="terminal-task-picker-list"
          role="listbox"
          data-testid="terminal-task-picker-list"
          className={
            "absolute left-0 top-full z-40 mt-1 max-h-72 w-[28rem] max-w-[80vw] overflow-y-auto rounded " +
            "border border-border-strong bg-surface-raised p-1 text-[12px] shadow-2xl"
          }
        >
          <button
            type="button"
            role="option"
            aria-selected={active === 0}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setActive(0)}
            onClick={() => pick("")}
            className={`${optionClassName(0)} text-text-muted`}
          >
            {t("terminal.view.unbound")}
          </button>
          {shown.map((task, index) => (
            <button
              key={task.taskId}
              type="button"
              role="option"
              aria-selected={active === index + 1}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index + 1)}
              onClick={() => pick(task.taskId)}
              className={optionClassName(index + 1)}
            >
              <span className="w-full truncate text-text">{task.title}</span>
              {/* G10:实体 id 只作辅助文本,标题才是可读主体。 */}
              <span className="font-mono text-[10px] text-text-faint">{task.taskId}</span>
            </button>
          ))}
          {matches.length === 0 && <p className="px-2 py-2 text-text-faint">{t("terminal.view.taskPickerEmpty")}</p>}
          {matches.length > shown.length && (
            <p className="px-2 py-1 text-[11px] text-text-faint">
              {t("terminal.view.taskPickerMore", { count: matches.length - shown.length })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function filterTasks(tasks: readonly TerminalTaskOption[], query: string): TerminalTaskOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...tasks];
  return tasks.filter(
    (task) => task.title.toLowerCase().includes(needle) || task.taskId.toLowerCase().includes(needle),
  );
}
