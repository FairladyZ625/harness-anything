interface GraphRelationStateProps {
  readonly state: "ready" | "loading" | "error";
}

export function GraphRelationReadGate({ state }: GraphRelationStateProps) {
  if (state === "ready") return null;
  return (
    <p role={state === "error" ? "alert" : "status"} className="p-6">
      {state === "error" ? "关系读取失败，请刷新后重试。" : "正在加载完整关系…"}
    </p>
  );
}

export function GraphRelationBasis({ count }: { readonly count: number }) {
  return (
    <span
      data-testid="graph-relation-basis"
      title="孤立/族归属按这份完整关系集判定;进入视图时读取,台账变化后重进或刷新时更新"
    >
      关系 · {count} 条 · 完整
    </span>
  );
}
