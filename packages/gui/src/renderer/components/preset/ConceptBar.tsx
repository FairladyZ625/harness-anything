import { ArrowRight } from "@phosphor-icons/react";
import { FLOW_STEPS } from "./shared";

export function ConceptBar() {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {FLOW_STEPS.map((step, i) => (
          <span key={step} className="flex items-center gap-1.5">
            {i > 0 && <ArrowRight className="text-[11px] text-text-faint" />}
            <span className="rounded border border-border bg-surface-raised px-1.5 py-px font-mono text-[10px] text-text-muted">
              {step}
            </span>
          </span>
        ))}
        <span className="ml-1 text-[10px] text-text-faint">· 物化流</span>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="text-[11px] text-text-muted">
          Vertical 说「用哪个」（决策）· Template Library 说「那个长什么样、有哪些语言版本」（存储）
        </span>
        <span className="text-[10px] text-text-faint">statusMapping 归 Engine，不在此页</span>
      </div>
    </div>
  );
}
