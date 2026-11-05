# daemon 外部探针

daemon 自己的监测看不到事件循环卡死。这个探针以独立进程运行：按固定间隔发一组最小请求，从操作系统读 daemon 进程的 CPU、内存、线程与文件描述符；daemon 不再应答或持续满载时抓一次现场。

它是只读的：不重启、不停止、不向 daemon 发信号。唯一可能短暂挂起目标进程的是抓栈用的系统工具（macOS 的 `sample`）；Linux 抓栈只读 `/proc` 文件。

## 运行

```bash
ha daemon probe --user-root ~/.harness --daemon-id default
```

默认：每 5s 一个样本，每个请求 2s 超时，1s 以上记为 `slow`；连续无响应 30s、CPU 持续 60s ≥90%，或 RSS 超过 8 GiB 时抓现场。Ctrl-C 停止，结束回执给出样本数与抓现场次数。

```bash
ha daemon probe --interval 5s --timeout 2s --slow-ms 1000 \
  --unresponsive 30s --cpu-percent 90 --cpu-sustain 60s \
  --rss-bytes 8589934592 --cooldown 10m \
  --user-root ~/.harness --daemon-id default
```

验收时可限定运行长度：

```bash
ha daemon probe --iterations 120 --interval 5s --json
ha daemon probe --duration 10m
```

`--json` 不逐行打印样本，只在结束时输出一份运行回执；不加时每个样本打印一行，终端或日志采集器能实时看到。

## 记录什么

样本与抓现场事件以 `daemon-probe/v1` JSONL 追加到
`<user-root>/logs/daemon-<daemon-id>-probe-<YYYYMMDD>.jsonl`，按 UTC 日轮转，默认保留 7 天（`--kept-days`）。每个样本包含：

- `state`：`up`（两个请求都在 slow 阈值内应答）、`slow`（应答了但达到 `--slow-ms`）、`down`（hello 或 status 超时/失败）；
- `latencyMs`、`helloMs`、`statusMs` 与失败码；
- `cpuPercent`、`rssBytes`、`threadCount`、`openFileCount`、计数器来源，以及 `metricsUnavailable`（平台取不到的字段名）。

计数器来源：Linux 读 `/proc/<pid>/{stat,status,fd}`，macOS 用 `ps`/`lsof`，Windows 用 PowerShell `Get-Process`（尽力而为、验证较少；取不到的字段保持 `null` 并列入 `metricsUnavailable`）。

同一次事件只抓一次现场。条件消失后才会重新武装；清除后再次发生要等过 `--cooldown`。现场文件写到 `<user-root>/logs/probe-captures/`：

- macOS：`sample <pid> <seconds> -file <文件>`；
- Linux：把 `/proc/<pid>/{status,stack,wchan,syscall,stat}` 拼成一个文本文件；读不到的文件在正文里写明，不让整次抓现场失败；
- JS 栈：仅当 daemon 在 `protocol.hello.methods` 里宣告了方法才调用。约定方法名是 `daemon.diagnostics.stack`；`--js-stack-method` 只接受这个只读诊断名（`daemon.stop` 这类控制方法会被拒绝）。不存在时记录 `not-advertised` 后继续。

## 汇总

```bash
ha daemon probe summary --window 24h
ha daemon probe summary --day 20261103
ha daemon probe summary --day 20261103 --until 2026-11-03T15:20:00Z
ha daemon probe summary --window 1h --min-silence 5m --json
```

`--until <ISO-8601>` 冻结窗口终点，正在进行的当天也能在事后复现同一份统计。

汇总输出两个互相独立的视图：

1. **探针时间线**：样本数、可用率（有应答样本 / 全部样本）、健康率、延迟分位、停机段、慢段与现场文件。窗口内没有样本时输出 `unobserved`，不会把缺数据算成 0% 可用。
   汇总还会报告已观测与未观测时长：探针两次运行之间、或样本间隔超过运行间隔的缺口记为
   未观测，不计入停机。

2. **离线日志视图**（探针从未运行也能用）：按 UTC 日的 `process_start` 启动次数、`repo_attach_completed.durationMs` 的挂载耗时，以及不可用段。正常重启由 `process_exit → 下一次 process_start` 定界；有 start 无 exit 的进程用该 pid 最后一条 conn 活动定界并标 `unrecorded-stop`——2026-11-03 的 56 分钟卡死就是这样出现的。conn 日志还能给出“没有请求活动”的静默段，单独列出，不计入停机。

两种日志都逐行流式读取；汇总只为每个 pid 保留首末时间戳和每分钟 1 bit 的活动位图，因此一天 70 MB 的 conn 日志不会整体读入内存。

## 常驻运行（不在本仓安装）

把探针装成常驻服务属于宿主变更。下面是给机器主人的示例，本仓库不代为安装。

macOS `launchd` 用户代理（`~/Library/LaunchAgents/com.example.harness-probe.plist`）——把占位符替换成该机器上的 `ha` 与 user-root 绝对路径：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.example.harness-probe</string>
  <key>ProgramArguments</key><array>
    <string>HA_ABSOLUTE_PATH</string><string>daemon</string><string>probe</string>
    <string>--user-root</string><string>USER_ROOT_ABSOLUTE_PATH</string>
    <string>--daemon-id</string><string>default</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>USER_ROOT_ABSOLUTE_PATH/logs/daemon-probe.stderr.log</string>
</dict></plist>
```

Linux systemd 用户单元（`~/.config/systemd/user/harness-probe.service`）：

```ini
[Unit]
Description=Harness Anything external daemon probe
After=default.target

[Service]
ExecStart=HA_ABSOLUTE_PATH daemon probe --user-root %h/.harness --daemon-id default
Restart=always
RestartSec=5
StandardError=append:%h/.harness/logs/daemon-probe.stderr.log

[Install]
WantedBy=default.target
```

启用：`systemctl --user daemon-reload && systemctl --user enable --now harness-probe`。探针只写自己的时间线与现场文件；这些文件的轮转和采集不在本命令范围内。
