import type { ReactNode } from "react";

/**
 * 「该有而无」的空态说明(标准 §4.2):一行弱色小字,不画大框。
 * 集合为空且空是正常 → 调用方整块不渲染,不使用本组件。
 */
export function Empty({ children }: { readonly children: ReactNode }) {
  return <p className="py-1 ui-micro text-text-faint">{children}</p>;
}
