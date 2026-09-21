export function ResultPagination({
  page,
  total,
  size,
  onChange,
  label,
}: {
  readonly page: number;
  readonly total: number;
  readonly size: number;
  readonly onChange: (page: number) => void;
  readonly label: string;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (pages === 1) return null;
  return (
    <nav aria-label={`${label}分页`} className="flex flex-wrap items-center gap-3 text-sm text-text-muted">
      <button
        type="button"
        disabled={page === 0}
        onClick={() => onChange(page - 1)}
        className="rounded border border-border px-2 py-1 disabled:opacity-40"
      >
        上一页
      </button>
      <span>
        {page + 1} / {pages} 页 · {total} 项
      </span>
      <button
        type="button"
        disabled={page + 1 >= pages}
        onClick={() => onChange(page + 1)}
        className="rounded border border-border px-2 py-1 disabled:opacity-40"
      >
        下一页
      </button>
    </nav>
  );
}
