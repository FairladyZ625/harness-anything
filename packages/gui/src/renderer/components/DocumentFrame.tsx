import type { ReactNode } from "react";

/** Shared bounded viewer: controls remain reachable while the document scrolls. */
export function DocumentFrame({
  toolbar,
  children,
  testId,
  fill = false,
}: {
  readonly toolbar: ReactNode;
  readonly children: ReactNode;
  readonly testId?: string;
  readonly fill?: boolean;
}) {
  return (
    <section
      data-testid={testId}
      className={`flex min-h-0 min-w-0 flex-col overflow-hidden bg-surface ${fill ? "h-full" : "max-h-[var(--long-content-cap)] rounded-lg border border-border"}`}
    >
      <header className="shrink-0 border-b border-border bg-surface-raised">{toolbar}</header>
      <div className="min-h-0 min-w-0 overflow-auto" data-document-scroll>
        {children}
      </div>
    </section>
  );
}

/** Shared render-failure strip for byte previews; the original file stays openable. */
export function PreviewFailure({ message }: { readonly message: string }) {
  return (
    <div role="alert" className="p-6 ui-meta text-danger">
      无法渲染文件：{message}。仍可使用系统查看器打开原始文件。
    </div>
  );
}
