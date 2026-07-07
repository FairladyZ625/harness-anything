import { NodeProps } from '@xyflow/react';

export function ModuleGroupNode({ data, width, height }: NodeProps) {
  return (
    <div 
      className="rounded-lg relative border-2 border-dashed"
      style={{ 
        width, 
        height, 
        backgroundColor: 'rgba(255, 255, 255, 0.02)',
        borderColor: 'var(--color-border)',
      }}
    >
      <div className="absolute -top-6 left-0 text-[11px] font-mono text-[var(--color-text-muted)] tracking-wider">
        MODULE: {data.label as string}
      </div>
    </div>
  );
}
