/**
 * 标签流(标准 §4):可变宽度的小标签换行排列,用于「接下来」这类不需要
 * 逐行比较的集合——不占等高行,空了整块消失(标准 §1)。
 */
export function PillFlow({
  items,
}: {
  readonly items: readonly {
    readonly label: string;
    readonly title?: string;
    readonly pinned?: boolean;
    readonly onClick?: () => void;
  }[];
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item, index) => {
        const cls = `max-w-full truncate rounded-xs border px-[9px] py-1 ui-body ${
          item.pinned === true
            ? "border-status-planned/50 bg-status-planned/10"
            : "border-border bg-text/5 hover:border-status-planned/60"
        }`;
        const content = (
          <>
            {item.pinned === true && <span className="text-status-planned">● </span>}
            {item.label}
          </>
        );
        if (item.onClick === undefined) {
          return (
            <span key={index} title={item.title} className={cls}>
              {content}
            </span>
          );
        }
        return (
          <button key={index} type="button" title={item.title} onClick={item.onClick} className={cls}>
            {content}
          </button>
        );
      })}
    </div>
  );
}
