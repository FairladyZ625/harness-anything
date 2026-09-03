/** Schedule interval 时长词表(唯一实现)。毫秒 ↔ `90s`/`5m`/`2h`/`1d` 的解析与格式化在这里
 * 各只有一份:CLI 的 `--every`、daemon 读侧的 trigger summary、GUI 表单的时长控件都从这里取,
 * 三方不再各带一张单位表。词表决定 `nextRunAt`(kernel schedule.ts),所以口径分歧会直接变成
 * 不同节点算出的 due 时刻不同;要求因此不是"看起来一致"而是同一份实现 + format→parse 无损可逆。
 * 纯函数、无 I/O、无 effect:protocol 目录不引 kernel barrel,也不引入节点本地时钟或显示偏好
 * (时区只属于 cron 触发器,不属于 interval)。 */

/** interval 的下限。领域权威是 `packages/kernel/src/domain/schedule.ts` 的 `everyMs` schema
 * minimum 与 `validateScheduleV1` 谓词;此处只是给 protocol/CLI/GUI 一个不重复的引用点,不是
 * 第二个权威——要改下限得改 kernel,不是改这里。 */
export const SCHEDULE_MIN_EVERY_MS = 60_000;

const unitMs = Object.freeze({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 });

export type ScheduleDurationUnit = keyof typeof unitMs;

/** 词表的单位集合,由小到大。parse 认它、format 从中取能整除的最大单位、GUI 单位控件按它渲染
 * ——三方共用同一张表,是 `parseScheduleDuration(formatScheduleDuration(x)) === x` 成立的全部
 * 理由。`ms` 在表里不是装饰:领域只要求 `everyMs` 是 ≥ 60_000 的安全整数,并不要求它是整秒,
 * 所以词表必须在整个合法域上是全函数,否则 90_001 这类值格式化后就读不回来,而"读不回来"在
 * 表单里的表现就是静默改写用户的间隔。 */
export const scheduleDurationUnits: readonly ScheduleDurationUnit[] = Object.freeze([
  "ms",
  "s",
  "m",
  "h",
  "d",
] satisfies ScheduleDurationUnit[]);

export function scheduleDurationUnitMs(unit: ScheduleDurationUnit): number {
  return unitMs[unit];
}

/** 毫秒 → {数值, 单位}:取能整除的最大单位。正数被大于它的单位取模必然不为 0,所以只需比余数。 */
export function splitScheduleDuration(everyMs: number): {
  readonly amount: number;
  readonly unit: ScheduleDurationUnit;
} {
  let chosen: ScheduleDurationUnit = "ms";
  for (const unit of scheduleDurationUnits) if (everyMs % unitMs[unit] === 0) chosen = unit;
  return { amount: everyMs / unitMs[chosen], unit: chosen };
}

export function formatScheduleDuration(everyMs: number): string {
  const { amount, unit } = splitScheduleDuration(everyMs);
  return `${amount}${unit}`;
}

export function parseScheduleDuration(value: string): number | null {
  const match = /^(\d+)(ms|[smhd])$/u.exec(value);
  if (match === null) return null;
  const milliseconds = Number(match[1]) * unitMs[match[2] as ScheduleDurationUnit];
  return Number.isSafeInteger(milliseconds) && milliseconds >= SCHEDULE_MIN_EVERY_MS ? milliseconds : null;
}
