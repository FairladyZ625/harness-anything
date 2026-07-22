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
