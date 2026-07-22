# 项目政策 settings

项目政策写在 `harness/harness.yaml`，随仓库接受审查。环境变量只作为机器或部署
层的紧急覆盖；若某命令已有显式 flag，flag 仍保持最高优先级。YAML 或环境变量
出现非法值时，命令会在创建写协调器、改变仓库状态之前失败。

## Execution consent

```yaml
settings:
  execution:
    consentTtlMs: 86400000
```

`settings.execution.consentTtlMs` 控制内容仍匹配时，human execution consent 的独立
新鲜度上限。默认值为 `86400000` 毫秒（24 小时）。
`HARNESS_EXECUTION_CONSENT_TTL_MS` 覆盖 YAML。值必须是以毫秒计的正安全整数。
content pin、principal、action scope 与过期校验不会因此放宽。

## Multica snapshot cache

```yaml
settings:
  adapters:
    multica:
      staleTtlMs: 300000
```

`settings.adapters.multica.staleTtlMs` 控制 provider 不可用时，缓存的 Multica
snapshot 可保持 stale-but-usable 的时长。默认值为 `300000` 毫秒（5 分钟）。
`HARNESS_MULTICA_STALE_TTL_MS` 覆盖 YAML。值必须是以毫秒计的正安全整数。

两个键的生效顺序均为：环境变量覆盖、项目 YAML、文档化的编译默认值。当前相关
命令没有单次 TTL flag。

## 运维环境变量覆盖

下列限制属于本机运行环境，不进入项目 YAML。非法值会在对应子进程、扫描或 GUI
窗口启动之前失败。

| 变量 | 默认值 | 合法范围 / 优先级 |
| --- | ---: | --- |
| `HARNESS_FDE_PROBE_TIMEOUT_MS` | `10000` | `1..120000` 毫秒；detector option/runner 注入仍更高。 |
| `HARNESS_FDE_PROBE_MAX_BUFFER_BYTES` | `1048576` | `1..67108864` bytes；探测失败仍是 indeterminate，绝不误报 encrypted。 |
| `HARNESS_GIT_MAX_BUFFER_BYTES` | `268435456` | `1..1073741824` bytes；kernel 与 local adapter 的 Git 子进程同源。 |
| `HARNESS_PROJECTION_MAX_CHANGED_PATHS` | `50000` | `1..1000000` paths；超限仍返回 `dirty-unbounded`。 |
| `HARNESS_RUNTIME_LOG_SEARCH_DEPTH` | `8` | `1..64`；显式 `RuntimeLogOptions.maxSearchDepth` 优先。 |
| `ELECTRON_RENDERER_URL` | 未设置 | 仅开发模式允许 `http://127.0.0.1:<显式端口>`；验证后的 origin 同时驱动 load、navigation、IPC trust 与 CSP。远端 host、HTTPS、凭据和隐式端口都会拒绝。 |
| `HARNESS_PRESET_CONTEXT_MAX_MILESTONES` | `20` | `1..200`；显式 builder option 优先。 |
| `HARNESS_PRESET_CONTEXT_MAX_NOTES` | `3` | `1..50`；显式 builder option 优先。 |

receipt-honesty benchmark 还支持 `HARNESS_BENCH_LOCK_MAX_WAIT_MS`、
`HARNESS_BENCH_LOCK_INITIAL_DELAY_MS`、`HARNESS_BENCH_LOCK_MAX_DELAY_MS`、
`HARNESS_BENCH_BARRIER_TIMEOUT_MS`、`HARNESS_BENCH_BARRIER_POLL_MS`。
对应的 `--lock-*` / `--barrier-*` flag 高于 env。lock retry 默认仍为
`100/5/10` 毫秒，barrier timeout/poll 默认仍为 `10000/5` 毫秒。
