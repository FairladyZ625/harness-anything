/**
 * GUI 读 daemon 的轮询间隔与聚焦刷新策略:唯一定义处(2026-09-14 轮询降负载裁定)。
 *
 * 读面按「数据靠什么刷新」分三类,各查询按数据性质从这里取值,不各自立常量:
 *
 *   1. 台账探针(repo.tasks.list):唯一的高频计时器,聚焦时无视 staleTime 立即重探。
 *      它推进 cut(watermark + sourceRevision),cut 前进由 invalidateLedgerDependents
 *      扇出到所有台账派生读——派生读因此既不需要自己的计时器,也不需要自己的聚焦
 *      重取:聚焦时探针先读,cut 变了派生读才跟着读。
 *   2. daemon 级读面(system status / connections status):台账 cut 覆盖不到,各自的
 *      低频计时器是唯一周期刷新来源,保留;聚焦不重读。
 *   3. agenda 续读:未读完的游标窗口靠它拉完,读完即停,不是周期轮询。
 */
export const QUERY_PACING_MS = {
  /** 台账探针间隔:cut 前进的唯一驱动(taskListQuery)。 */
  ledgerProbe: 2_000,
  /** system status:daemon 级读面,cut 覆盖不到,自持低频轮询。 */
  systemStatus: 10_000,
  /** connections status:admin 面,cut 覆盖不到,自持低频轮询。 */
  connectionStatus: 30_000,
  /** Token 消耗聚合读:数据在派工流里,runtime_metrics 增长不推进台账 cut,自持低频轮询。 */
  tokenUsage: 10_000,
  /** agenda 未读完游标的续读节奏(读完即停,不是周期轮询)。 */
  agendaCatchUp: 5_000,
} as const;

/** 台账探针的聚焦策略:聚焦即重探(数据新鲜也读);其余读面沿用全局默认不重读。 */
export const LEDGER_PROBE_FOCUS_REFETCH = "always" as const;

/**
 * renderer QueryClient 默认项(main.tsx 建客户端用)。聚焦不触发重读是收敛后的全局
 * 策略,唯一例外是台账探针(见上);台账派生读的新鲜度由探针推进 cut 后的扇出保证。
 */
export const rendererQueryDefaults = {
  queries: {
    retry: 1,
    refetchOnWindowFocus: false,
  },
} as const;
