import type { ObserveRow, ObserveRowLog, ObserveRowMark } from "./daemon-observe-model.ts";

/**
 * 观察页分析面的纯数据统计:时序分桶、慢操作聚合、异常聚类、透镜候选,以及第二轮
 * 增补的深层分析(异味嗅探 / 单写锁争用 / Top Talkers / 信噪比)。统计累积器随
 * ObserveRowLog 的水位增量推进(见 observeStatsLog),不做 IO、不碰 React;窗口推导
 * (15m/1h)在快照时按固定桶环形缓冲切片,代价与累计行数无关。
 */

/**
 * 时序吞吐分桶:固定 10s × 360 桶的环形缓冲(覆盖近 1h;15m 视图只取末 90 桶)。
 * 桶下标 = floor(atMs / OBSERVE_BUCKET_MS),槽位 = 下标 mod 360;时间前进时清空被
 * 覆盖的槽位(跳跃 ≥ 一整圈则整环清零),比窗口更老的行只进总数不进桶——HUD 的
 * 每次更新代价与累计行数无关(checkpoint 的固定桶方案,不在 React render 里做归约)。
 */
export const OBSERVE_BUCKET_MS = 10_000,
  OBSERVE_BUCKET_COUNT = 360,
  /** 15m 窗口的桶数(10s/桶);1h 窗口用全部 ≤360 桶。 */
  OBSERVE_WINDOW_15M_BUCKETS = 90;

/** HUD 可选的观察窗口跨度;窗口推导(嗅探/争用/信噪/Top Talkers)共用同一口径。 */
export type ObserveWindowSpan = "15m" | "1h";

/** 慢锁判据:写操作单次耗时超过该值视为潜在单写队列堵塞元凶(任务书 800ms 线)。 */
export const OBSERVE_SLOW_LOCK_MS = 800,
  /** 频密轮询判据:单方法在单个 10s 桶内的请求数折算速率超过该值(req/s)。 */
  OBSERVE_POLL_BURST_PER_SEC = 5,
  /** 失败毛刺判据:窗口期失败+缺口行占比超过该百分比。 */
  OBSERVE_FAILURE_SPIKE_PCT = 15;

/** HUD 的一个时序桶:该 10s 窗口内的行数、异常数与读写/信噪分类计数。 */
export interface ObserveTimeSlice {
  readonly startMs: number;
  readonly endMs: number;
  readonly count: number;
  readonly anomalies: number;
  readonly writes: number;
  readonly reads: number;
  readonly signal: number;
  readonly overhead: number;
}

/** 单个 RPC 方法的耗时聚合:次数、最大值与全量耗时序列(分位点在展示层按需排序)。 */
export interface ObserveOpStat {
  readonly method: string;
  readonly count: number;
  readonly maxMs: number;
  readonly durations: readonly number[];
}

/** 异常指纹聚类:同类失败(方法+失败码)或保留缺口去重后的计数与最近一次时间。 */
export interface ObserveAnomalyStat {
  readonly key: string;
  readonly kind: "error" | "gap";
  /** 展示标签:错误给「方法 · 失败码」;gap 给保留原因(组件层再本地化)。 */
  readonly label: string;
  readonly reason: string | null;
  /** 选中该聚类的检索词(searchText 的子串;写入 pane 过滤框)。 */
  readonly matchText: string;
  readonly count: number;
  readonly lastAt: string | null;
  /** 首次出现的完整记录(悬停看根因样本)。 */
  readonly sample: string;
}

/** 透镜候选:活跃 task/session(事件栏)、method/node(日志栏),按出现频次排序。 */
export interface ObserveLensValue {
  readonly kind: "task" | "session" | "method" | "node";
  readonly value: string;
  readonly count: number;
}

export interface ObserveVolumeStat {
  readonly name: string;
  readonly count: number;
  readonly percentage: number;
}

/**
 * 嗅探出的系统异味:value 的量纲随 kind 变化(slow_lock_holder→ms、spinloop_polling→
 * req/s、spike_failures→百分比),matchText 是点击下钻的检索词(方法名)。
 */
export interface ObserveSmellStat {
  readonly kind: "slow_lock_holder" | "spinloop_polling" | "spike_failures";
  readonly label: string;
  readonly value: number;
  readonly matchText: string;
}

/** 单写锁争用压力:窗口内读写计数、慢写条数与最大并发重叠度(区间 [at-duration, at])。 */
export interface ObserveContentionStat {
  readonly level: "smooth" | "mild" | "contended";
  readonly writeOps: number;
  readonly readOps: number;
  /** 写占读写总数的百分比(无读写分类行时为 0)。 */
  readonly writePct: number;
  readonly slowWrites: number;
  readonly overlap: number;
}

/** 信噪比:业务推进行 vs 机械巡检行的窗口计数与高价值信号占比(中性行不计入分母)。 */
export interface ObserveSignalStat {
  readonly progress: number;
  readonly overhead: number;
  readonly progressPct: number;
}

/** 热点主体:窗口内请求/事件量最高的 task/caller/连接,占比以窗口总行数为分母。 */
export interface ObserveTalkerStat {
  readonly subject: string;
  readonly count: number;
  readonly percentage: number;
}

/** 单窗口(15m/1h)的深层分析快照:嗅探、争用、信噪与 Top Talkers 同源同窗口。 */
export interface ObserveWindowStats {
  readonly smells: readonly ObserveSmellStat[];
  readonly contention: ObserveContentionStat;
  readonly signal: ObserveSignalStat;
  readonly talkers: readonly ObserveTalkerStat[];
}

export interface ObserveStats {
  readonly bucketMs: number;
  /** 旧→新的时序桶(定长 ≤ 360,含零桶作基线);窗口裁剪由展示层做。 */
  readonly buckets: readonly ObserveTimeSlice[];
  /** 摄入总行数与异常总行数(含比桶窗口更老的行)。 */
  readonly total: number;
  readonly anomalies: number;
  /** 全部耗时记录的整体分位点与最大值(无耗时记录时为 null)。 */
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly maxMs: number | null;
  /** 按 maxMs 降序的方法耗时聚合(慢操作排行)。 */
  readonly ops: readonly ObserveOpStat[];
  /** 按次数降序的命令/方法/事件调用量分布(带占比)。 */
  readonly volumes: readonly ObserveVolumeStat[];
  /** 按次数降序的异常聚类。 */
  readonly clusters: readonly ObserveAnomalyStat[];
  readonly lens: {
    readonly tasks: readonly ObserveLensValue[];
    readonly sessions: readonly ObserveLensValue[];
    readonly methods: readonly ObserveLensValue[];
    readonly nodes: readonly ObserveLensValue[];
  };
  /** 两个窗口跨度的深层分析快照(嗅探/争用/信噪/Top Talkers),展示层按 HUD 选窗取用。 */
  readonly windows: { readonly "15m": ObserveWindowStats; readonly "1h": ObserveWindowStats };
}

/** 分位点(0<q≤1):最近邻上取整秩,空序列返回 null;调用方传排序副本亦可。 */
export function observePercentile(durations: readonly number[], q: number): number | null {
  if (durations.length === 0) return null;
  const sorted = [...durations].sort((left, right) => left - right);
  return sorted[percentileRank(sorted.length, q)]!;
}

function percentileRank(size: number, q: number): number {
  return Math.min(size - 1, Math.max(0, Math.ceil(q * size) - 1));
}

interface ObserveOpMutable {
  count: number;
  maxMs: number;
  durations: number[];
}

interface ObserveAnomalyMutable {
  key: string;
  kind: "error" | "gap";
  label: string;
  reason: string | null;
  matchText: string;
  count: number;
  lastAt: string | null;
  lastAtMs: number;
  sample: string;
}

/** 慢写记录(慢锁嗅探与争用重叠度的输入):完成时刻 atMs + 区间长度 durationMs。 */
interface ObserveSlowWrite {
  readonly method: string;
  readonly atMs: number;
  readonly durationMs: number;
}

/** 窗口内失败行的方法归属记录(失败毛刺的下钻检索词来源)。 */
interface ObserveFailure {
  readonly method: string;
  readonly atMs: number;
}

/** 慢写/失败记录的摄入上限:超限丢最旧(慢写与失败都是稀疏事件,上限远超窗口展示所需)。 */
const SLOW_WRITE_CAP = 512,
  FAILURE_CAP = 2_048,
  /** Top Talkers 排行长度。 */
  TALKER_TOP = 5,
  /** 争用密度判据:窗口内慢写折算 ≥0.5 条/分钟即视为繁忙(与重叠判据并联)。 */
  CONTENDED_PER_MINUTE = 0.5;

const OVERHEAD_METHOD = /(status|ping|tail|poll|heartbeat|hello|probe)/,
  PROGRESS_EVENT = /^(task|fact|decision|review|doc|schedule|relation|execution)[-_]/;

/**
 * 信噪分类:机械化巡检/心跳方法(observe.tail、daemon.status、protocol.hello…)是
 * Overhead;写类操作与业务推进事件(task、fact、decision、review 等前缀)是 Progress;
 * 其余(普通读、未知形状)为中性,不计入信噪比分母。
 */
function observeSignalKind(row: ObserveRow): "progress" | "overhead" | null {
  if (OVERHEAD_METHOD.test(row.type)) return "overhead";
  if (row.opClass === "write") return "progress";
  if (row.durationMs === null && row.ok === null && row.gapMarker === null && PROGRESS_EVENT.test(row.type))
    return "progress";
  return null;
}

/** 慢写区间的最大并发重叠度:事件扫描,同一时刻先出后进(端点相接不算重叠)。 */
function maxOverlapOf(records: readonly ObserveSlowWrite[]): number {
  const points: { readonly t: number; readonly d: number }[] = [];
  for (const record of records) {
    points.push({ t: record.atMs - record.durationMs, d: 1 }, { t: record.atMs, d: -1 });
  }
  points.sort((left, right) => left.t - right.t || left.d - right.d);
  let active = 0,
    peak = 0;
  for (const point of points) {
    active += point.d;
    if (active > peak) peak = active;
  }
  return peak;
}

function bumpKeyBucket(indexed: Map<string, Map<number, number>>, key: string, bucketIndex: number): void {
  let counts = indexed.get(key);
  if (counts === undefined) {
    counts = new Map<number, number>();
    indexed.set(key, counts);
  }
  counts.set(bucketIndex, (counts.get(bucketIndex) ?? 0) + 1);
}

/**
 * 统计累积器:逐行摄入(observeStatsLog 只喂 growth 新增行),内部全是固定桶环 + Map
 * 计数 + 有界记录表,快照(ObserveStats)按需生成。不做 IO、不碰 React;测试直接驱动
 * 同一入口。
 */
export class ObserveStatsState {
  private total = 0;
  private anomalies = 0;
  private latestBucket = -1;
  private readonly bucketCounts = new Array<number>(OBSERVE_BUCKET_COUNT).fill(0);
  private readonly bucketAnomalies = new Array<number>(OBSERVE_BUCKET_COUNT).fill(0);
  private readonly bucketWrites = new Array<number>(OBSERVE_BUCKET_COUNT).fill(0);
  private readonly bucketReads = new Array<number>(OBSERVE_BUCKET_COUNT).fill(0);
  private readonly bucketSignal = new Array<number>(OBSERVE_BUCKET_COUNT).fill(0);
  private readonly bucketOverhead = new Array<number>(OBSERVE_BUCKET_COUNT).fill(0);
  /** 全部桶环:时间前进/跳跃时的清零只写这一处,新增环自动获得同一推进语义。 */
  private readonly rings = [
    this.bucketCounts,
    this.bucketAnomalies,
    this.bucketWrites,
    this.bucketReads,
    this.bucketSignal,
    this.bucketOverhead,
  ];
  private readonly ops = new Map<string, ObserveOpMutable>();
  private readonly types = new Map<string, number>();
  private readonly clusters = new Map<string, ObserveAnomalyMutable>();
  private readonly tasks = new Map<string, number>();
  private readonly sessions = new Map<string, number>();
  private readonly nodes = new Map<string, number>();
  /** 方法/主体的稀疏桶计数(绝对桶下标→次数):频密轮询嗅探与 Top Talkers 的窗口来源。 */
  private readonly methodBuckets = new Map<string, Map<number, number>>();
  private readonly subjectBuckets = new Map<string, Map<number, number>>();
  private slowWrites: ObserveSlowWrite[] = [];
  private failures: ObserveFailure[] = [];
  /** 全量耗时序列随摄入追加(与各 op 的序列同源);快照只排序一次。 */
  private readonly durations: number[] = [];
  private overallMaxMs: number | null = null;

  ingest(row: ObserveRow): void {
    this.total += 1;
    bump(this.types, row.type);
    const failed = row.ok === false,
      gapped = row.gapMarker !== null;
    if (failed || gapped) this.anomalies += 1;
    if (row.atMs !== null) this.bucketRow(row, failed || gapped);
    if (row.durationMs !== null) this.ingestOp(row.type, row.durationMs);
    if (failed) this.ingestCluster(row);
    else if (gapped) this.ingestGapCluster(row);
    for (const chip of row.refs) {
      if (chip.kind === "task") bump(this.tasks, chip.label);
      else if (chip.kind === "session") bump(this.sessions, chip.label);
    }
    if (row.nodeId !== null) bump(this.nodes, row.nodeId);
    if (failed && row.atMs !== null) {
      this.failures.push({ method: row.type, atMs: row.atMs });
      if (this.failures.length > FAILURE_CAP) this.failures.splice(0, this.failures.length - FAILURE_CAP);
    }
    if (
      row.opClass === "write" &&
      row.durationMs !== null &&
      row.durationMs > OBSERVE_SLOW_LOCK_MS &&
      row.atMs !== null
    ) {
      this.slowWrites.push({ method: row.type, atMs: row.atMs, durationMs: row.durationMs });
      if (this.slowWrites.length > SLOW_WRITE_CAP) this.slowWrites.splice(0, this.slowWrites.length - SLOW_WRITE_CAP);
    }
  }

  snapshot(): ObserveStats {
    const buckets = this.buildBuckets();
    this.pruneSparse(this.methodBuckets);
    this.pruneSparse(this.subjectBuckets);
    this.pruneRecords();
    const ops: ObserveOpStat[] = [];
    for (const [method, op] of this.ops)
      ops.push({ method, count: op.count, maxMs: op.maxMs, durations: op.durations });
    ops.sort((left, right) => right.maxMs - left.maxMs || right.count - left.count);
    const volumes: ObserveVolumeStat[] = [...this.types.entries()]
      .map(([name, count]) => ({
        name,
        count,
        percentage: this.total > 0 ? (count / this.total) * 100 : 0,
      }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
    const clusters = [...this.clusters.values()]
      .map((cluster): ObserveAnomalyStat => {
        const { key, kind, label, reason, matchText, count, lastAt, sample } = cluster;
        return { key, kind, label, reason, matchText, count, lastAt, sample };
      })
      .sort((left, right) => right.count - left.count);
    // 整体分位点只排序一次:P50/P95 共用同一有序副本(5000 行滚动下的热点路径)。
    const sorted = this.durations.length === 0 ? null : [...this.durations].sort((left, right) => left - right),
      p50Ms = sorted === null ? null : sorted[percentileRank(sorted.length, 0.5)]!,
      p95Ms = sorted === null ? null : sorted[percentileRank(sorted.length, 0.95)]!;
    return {
      bucketMs: OBSERVE_BUCKET_MS,
      buckets,
      total: this.total,
      anomalies: this.anomalies,
      p50Ms,
      p95Ms,
      maxMs: this.overallMaxMs,
      ops,
      volumes,
      clusters,
      lens: {
        tasks: topLens(this.tasks, "task"),
        sessions: topLens(this.sessions, "session"),
        methods: topLens(new Map([...this.ops].map(([method, op]) => [method, op.count])), "method"),
        nodes: topLens(this.nodes, "node"),
      },
      windows: {
        "15m": this.deriveWindow(buckets.slice(-OBSERVE_WINDOW_15M_BUCKETS)),
        "1h": this.deriveWindow(buckets),
      },
    };
  }

  private buildBuckets(): ObserveTimeSlice[] {
    const buckets: ObserveTimeSlice[] = [],
      first = Math.max(0, this.latestBucket - (OBSERVE_BUCKET_COUNT - 1));
    for (let index = first; index <= this.latestBucket; index += 1) {
      const slot = index % OBSERVE_BUCKET_COUNT;
      buckets.push({
        startMs: index * OBSERVE_BUCKET_MS,
        endMs: (index + 1) * OBSERVE_BUCKET_MS,
        count: this.bucketCounts[slot]!,
        anomalies: this.bucketAnomalies[slot]!,
        writes: this.bucketWrites[slot]!,
        reads: this.bucketReads[slot]!,
        signal: this.bucketSignal[slot]!,
        overhead: this.bucketOverhead[slot]!,
      });
    }
    return buckets;
  }

  private bucketRow(row: ObserveRow, anomaly: boolean): void {
    const atMs = row.atMs!,
      index = Math.floor(atMs / OBSERVE_BUCKET_MS);
    if (this.latestBucket < 0) this.latestBucket = index;
    if (index > this.latestBucket) {
      const jump = index - this.latestBucket;
      if (jump >= OBSERVE_BUCKET_COUNT) for (const ring of this.rings) ring.fill(0);
      else
        for (let cleared = this.latestBucket + 1; cleared <= index; cleared += 1) {
          const slot = cleared % OBSERVE_BUCKET_COUNT;
          for (const ring of this.rings) ring[slot]! = 0;
        }
      this.latestBucket = index;
    }
    if (index < this.latestBucket - (OBSERVE_BUCKET_COUNT - 1)) return;
    const slot = index % OBSERVE_BUCKET_COUNT;
    this.bucketCounts[slot]! += 1;
    if (anomaly) this.bucketAnomalies[slot]! += 1;
    if (row.opClass === "write") this.bucketWrites[slot]! += 1;
    else if (row.opClass === "read") this.bucketReads[slot]! += 1;
    const signal = observeSignalKind(row);
    if (signal === "progress") this.bucketSignal[slot]! += 1;
    else if (signal === "overhead") this.bucketOverhead[slot]! += 1;
    bumpKeyBucket(this.methodBuckets, row.type, index);
    if (row.subject !== null) bumpKeyBucket(this.subjectBuckets, row.subject, index);
  }

  private ingestOp(method: string, durationMs: number): void {
    let op = this.ops.get(method);
    if (op === undefined) {
      op = { count: 0, maxMs: 0, durations: [] };
      this.ops.set(method, op);
    }
    op.count += 1;
    op.durations.push(durationMs);
    this.durations.push(durationMs);
    if (durationMs > op.maxMs) op.maxMs = durationMs;
    if (this.overallMaxMs === null || durationMs > this.overallMaxMs) this.overallMaxMs = durationMs;
  }

  private ingestCluster(row: ObserveRow): void {
    const code = row.code ?? "",
      key = `err|${row.type}|${code}`,
      matchText = (code !== "" ? code : row.type).toLowerCase();
    this.bumpCluster(key, {
      kind: "error",
      label: code !== "" ? `${row.type} · ${code}` : row.type,
      reason: null,
      matchText,
      lastAt: row.at,
      lastAtMs: row.atMs ?? Number.NEGATIVE_INFINITY,
      sample: row.detail,
    });
  }

  private ingestGapCluster(row: ObserveRow): void {
    const gap = row.gapMarker!;
    this.bumpCluster(`gap|${gap.reason}`, {
      kind: "gap",
      label: gap.reason,
      reason: gap.reason,
      matchText: `gap ${gap.reason}`.toLowerCase(),
      lastAt: row.at,
      lastAtMs: Number.NEGATIVE_INFINITY,
      sample: row.detail,
    });
  }

  private bumpCluster(key: string, fresh: Omit<ObserveAnomalyMutable, "key" | "count">): void {
    const prior = this.clusters.get(key);
    if (prior === undefined) {
      this.clusters.set(key, { ...fresh, key, count: 1 });
      return;
    }
    prior.count += 1;
    if (fresh.lastAtMs > prior.lastAtMs) {
      prior.lastAt = fresh.lastAt;
      prior.lastAtMs = fresh.lastAtMs;
    }
  }

  /** 稀疏桶计数裁剪:删掉比 1h 环形窗口更老的条目,空键整条移除(快照时执行一次)。 */
  private pruneSparse(indexed: Map<string, Map<number, number>>): void {
    const floor = this.latestBucket - (OBSERVE_BUCKET_COUNT - 1);
    for (const [key, counts] of indexed) {
      for (const index of counts.keys()) if (index < floor) counts.delete(index);
      if (counts.size === 0) indexed.delete(key);
    }
  }

  /** 慢写/失败记录裁剪到 1h 窗口(比 15m 更宽的父窗口;15m 推导再做子集过滤)。 */
  private pruneRecords(): void {
    const floorMs = (this.latestBucket - (OBSERVE_BUCKET_COUNT - 1)) * OBSERVE_BUCKET_MS;
    if (this.slowWrites.some((record) => record.atMs < floorMs))
      this.slowWrites = this.slowWrites.filter((record) => record.atMs >= floorMs);
    if (this.failures.some((record) => record.atMs < floorMs))
      this.failures = this.failures.filter((record) => record.atMs >= floorMs);
  }

  /** 单窗口深层分析:嗅探异味、锁争用、信噪比与 Top Talkers,全部只读窗口内数据。 */
  private deriveWindow(buckets: readonly ObserveTimeSlice[]): ObserveWindowStats {
    const spanMs = buckets.length * OBSERVE_BUCKET_MS,
      fromMs = buckets.length === 0 ? Number.POSITIVE_INFINITY : buckets[0]!.startMs,
      sums = buckets.reduce(
        (acc, bucket) => ({
          count: acc.count + bucket.count,
          anomalies: acc.anomalies + bucket.anomalies,
          writes: acc.writes + bucket.writes,
          reads: acc.reads + bucket.reads,
          signal: acc.signal + bucket.signal,
          overhead: acc.overhead + bucket.overhead,
        }),
        { count: 0, anomalies: 0, writes: 0, reads: 0, signal: 0, overhead: 0 },
      ),
      slow = this.slowWrites.filter((record) => record.atMs >= fromMs),
      overlap = maxOverlapOf(slow),
      perMinute = spanMs > 0 ? (slow.length * 60_000) / spanMs : 0,
      level = slow.length === 0 ? "smooth" : overlap >= 2 || perMinute >= CONTENDED_PER_MINUTE ? "contended" : "mild",
      classified = sums.writes + sums.reads,
      progressTotal = sums.signal + sums.overhead;
    const worstSlow = slow.reduce<ObserveSlowWrite | null>(
      (best, record) =>
        best === null ||
        record.durationMs > best.durationMs ||
        (record.durationMs === best.durationMs && record.method < best.method)
          ? record
          : best,
      null,
    );
    const burst = this.windowBurst(this.methodBuckets, fromMs),
      failurePct = sums.count > 0 ? (sums.anomalies / sums.count) * 100 : 0;
    const smells: ObserveSmellStat[] = [];
    if (worstSlow !== null)
      smells.push({
        kind: "slow_lock_holder",
        label: worstSlow.method,
        value: worstSlow.durationMs,
        matchText: worstSlow.method,
      });
    if (burst !== null && burst.count > OBSERVE_POLL_BURST_PER_SEC * (OBSERVE_BUCKET_MS / 1_000))
      smells.push({
        kind: "spinloop_polling",
        label: burst.key,
        value: (burst.count * 1_000) / OBSERVE_BUCKET_MS,
        matchText: burst.key,
      });
    if (failurePct > OBSERVE_FAILURE_SPIKE_PCT) {
      const topFailure = this.windowTopKey(this.failures, fromMs);
      smells.push({
        kind: "spike_failures",
        label: topFailure?.key ?? "",
        value: failurePct,
        matchText: topFailure?.key ?? "",
      });
    }
    return {
      smells,
      contention: {
        level,
        writeOps: sums.writes,
        readOps: sums.reads,
        writePct: classified > 0 ? (sums.writes / classified) * 100 : 0,
        slowWrites: slow.length,
        overlap,
      },
      signal: {
        progress: sums.signal,
        overhead: sums.overhead,
        progressPct: progressTotal > 0 ? (sums.signal / progressTotal) * 100 : 0,
      },
      talkers: this.windowTalkers(fromMs, sums.count),
    };
  }

  /** 窗口内单方法的最大桶计数(频密轮询嗅探):并列取字典序小者,保证快照确定性。 */
  private windowBurst(
    indexed: Map<string, Map<number, number>>,
    fromMs: number,
  ): { readonly key: string; readonly count: number } | null {
    let best: { key: string; count: number } | null = null;
    for (const [key, counts] of indexed) {
      for (const [index, count] of counts) {
        if (index * OBSERVE_BUCKET_MS < fromMs) continue;
        if (best === null || count > best.count || (count === best.count && key < best.key)) best = { key, count };
      }
    }
    return best;
  }

  /** 窗口内失败行最多的方法(失败毛刺的下钻目标):并列取字典序小者。 */
  private windowTopKey(
    records: readonly { readonly method: string; readonly atMs: number }[],
    fromMs: number,
  ): { readonly key: string; readonly count: number } | null {
    const counts = new Map<string, number>();
    for (const record of records) if (record.atMs >= fromMs) bump(counts, record.method);
    let best: { key: string; count: number } | null = null;
    for (const [key, count] of counts)
      if (best === null || count > best.count || (count === best.count && key < best.key)) best = { key, count };
    return best;
  }

  /** 窗口内主体计数排行(Top Talkers):次数降序、字典序升序并列,占比以窗口总行数为分母。 */
  private windowTalkers(fromMs: number, windowTotal: number): readonly ObserveTalkerStat[] {
    const counts = new Map<string, number>();
    for (const [subject, buckets] of this.subjectBuckets) {
      let total = 0;
      for (const [index, count] of buckets) if (index * OBSERVE_BUCKET_MS >= fromMs) total += count;
      if (total > 0) counts.set(subject, total);
    }
    return [...counts]
      .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
      .slice(0, TALKER_TOP)
      .map(([subject, count]) => ({
        subject,
        count,
        percentage: windowTotal > 0 ? (count / windowTotal) * 100 : 0,
      }));
  }
}

/** 观察页统计的增量缓存:与 ObserveFilterCache 同构,水位标记驱动「只喂新增行」。 */
export interface ObserveStatsCache {
  readonly source: ObserveRowLog;
  readonly version: number;
  readonly mark: ObserveRowMark;
  readonly state: ObserveStatsState;
  readonly stats: ObserveStats;
}

/**
 * 行存储上的增量统计:同一行集版本直接复用缓存;行集只增长(两端前插/追加)时只把
 * growth 新增行喂进累积器;丢行/整表替换(growth 为 null,贴底封顶会触发)时全量重建。
 * 统计全部在数据面完成且按版本记忆,React render 阶段零归约(任务 checkpoint 要求)。
 */
export function observeStatsLog(source: ObserveRowLog, cache: ObserveStatsCache | null): ObserveStatsCache {
  if (cache !== null && cache.source === source && cache.version === source.version) return cache;
  const prior = cache !== null && cache.source === source ? cache : null,
    growth = prior === null ? null : source.growth(prior.mark);
  if (prior !== null && growth !== null) {
    for (const row of growth.prepended) prior.state.ingest(row);
    for (const row of growth.appended) prior.state.ingest(row);
    return { source, version: source.version, mark: growth.mark, state: prior.state, stats: prior.state.snapshot() };
  }
  const state = new ObserveStatsState();
  for (const row of source) state.ingest(row);
  return { source, version: source.version, mark: source.mark(), state, stats: state.snapshot() };
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function topLens(counts: Map<string, number>, kind: ObserveLensValue["kind"]): readonly ObserveLensValue[] {
  return [...counts]
    .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
    .slice(0, 8)
    .map(([value, count]) => ({ kind, value, count }));
}
