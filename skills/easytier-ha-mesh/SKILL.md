---
name: easytier-ha-mesh
description: Use when deploying, migrating, or troubleshooting an EasyTier v2.6.4 P2P mesh network (with public relay fallback) across macOS, Windows, and Linux for Harness Anything (HA) Center and Edge nodes—including upgrading a local SQLite HA workspace in place to remote-center with IP-SAN self-signed TLS, mode selection (L3 TUN vs rootless no_tun+smoltcp), OS service installation (macOS LaunchDaemon/LaunchAgent with FD limit fix, Windows WinSW, Linux systemd), Clash Verge/Mihomo TUN exclusions, KCP+zstd tuning, fresh HA edge onboarding, and zero-basebackup ssh-reverse migration.
---

# EasyTier × Harness Anything（HA）跨平台组网与直连接入指南

## 1. 适用场景与模式选择（先选模式，再动手）

将 NAT 后的 HA Center 与多台 HA Edge（macOS / Windows / Linux）通过 **EasyTier `v2.6.4`** 组成加密三层虚拟局域网（优先 **UDP P2P 直连**，失败自动回落公网 Relay），替代高延迟、受跳板带宽限制的反向 SSH 隧道。

### 1.1 运行模式矩阵（按角色与权限选择）

| 模式 | 典型适用角色 | 需要 root/管理员？ | 与 Clash Verge TUN 冲突？ | 能力与限制 |
| :--- | :--- | :--- | :--- | :--- |
| **Mode A：完整 L3 TUN**（Edge 默认推荐） | macOS / Windows / Linux **Edge**、或需要双向直连的节点 | **需要**（macOS `LaunchDaemon` / Windows `WinSW` / Linux `systemd`） | **需要配置排除网段**（见 3.4） | 拥有真实虚拟网卡 `10.144.144.x/24`；可直连 Center Fleet、Keycloak 浏览器 OIDC 登录（IP SAN 零改写）及 P2P SSH。 |
| **Mode B：用户态 `no_tun` + `use_smoltcp`**（macOS Center 推荐） | 只提供入站服务的 **Center**（如 macOS 宿主），或无 `sudo` 权限环境 | **不需要**（用户态 `LaunchAgent` / `systemd --user`） | **无冲突**（不建 TUN，靠 `bind_device` 走物理网卡） | 入站由 `smoltcp` 转发到本机端口与 `proxy_network`；出站访问其他节点需配 `[[port_forward]]` 或 `socks5_proxy`。**不推荐用于需要浏览器打开 IP-SAN Keycloak 登录页的 Edge**。 |
| **Mode C：公网 Relay** | 公网云服务器（Linux VPS） | 需要（`systemd`） | 无 | 配 `mapped_listeners` 与安全组放行 TCP/UDP `11010`，负责打洞撮合与兜底中继。 |

### 1.2 已实测验证的默认参数
- **传输加速**：`enable_kcp_proxy = true` + `data_compress_algo = 2`（zstd）+ `multi_thread = true` + `bind_device = true`（跨运营商 1–2% UDP 丢包下吞吐可从 `0.41 MB/s` 提升至 `2.5–3.1 MB/s`）。
- **HA 传输模式**：直接使用 **`direct`**（原生 `node:tls` 直连 Center），不在 EasyTier 上叠加 `ssh-reverse`。
- **已有副本迁移**：保留原 `nodeId`、`credential`、`viewRoot`、`caPath`、`servername` / `loginServername`，可**零重签邀请、零重拉快照**平滑切换。

---

## 2. 拓扑与网段规划

| 角色 | 虚拟 IP 规划 | 监听 / 对等连接 | 职责 |
| :--- | :--- | :--- | :--- |
| **Relay（公网中继）** | `10.144.144.1/24` | `tcp/udp://0.0.0.0:11010` + `mapped_listeners` | NAT 穿透撮合；无法 P2P 时兜底转发 |
| **Center（中心节点）** | `10.144.144.2/24` | `tcp/udp://0.0.0.0:11010` + `[[proxy_network]]`（如 `10.211.55.2/32`） | 运行 HA Fleet Center（`0.0.0.0:<FLEET_PORT>`）与 Keycloak |
| **Edge（边缘节点）** | `10.144.144.3+N/24`（每台唯一） | `tcp/udp://0.0.0.0:11010`，`[[peer]]` 指向 Relay | 运行 HA Edge daemon 与 EasyTier 服务 |

> 生成强随机网络密钥：`openssl rand -base64 24 | tr -d "=+/ "`

---

## 3. 跨平台防坑铁律（必读）

### 3.1 EasyTier `v2.6.4` TOML 配置陷阱（全平台）
1. **zstd 压缩字段名**：TOML `[flags]` 中**必须写 `data_compress_algo = 2`**；写成 `compression = "zstd"` 会被静默忽略（仅 CLI 参数叫 `--compression zstd`）。
2. **`multi_thread` 与 `bind_device`**：除写入 `[flags]` 外，在服务启动命令行显式附带 `--multi-thread true --bind-device true`。
3. **修改后双重验证**：
   - 先执行 `easytier-core -c <config.toml> --multi-thread true --bind-device true --check-config`；
   - 启动后核查日志中的 `############### TOML ###############` 回显，确认打印出 `data_compress_algo = 2`、`enable_kcp_proxy = true`、`private_mode = true`。
4. **QUIC 备选分支**：默认 `enable_kcp_proxy = true`；仅当设备处于按流量计费网络或运营商对高并发 UDP 重传限流（丢包 >10%）时，将两端改为 `enable_quic_proxy = true`。

### 3.2 macOS 专属铁律（LaunchAgent / LaunchDaemon）
1. **文件描述符（FD）256 上限陷阱（极易踩坑）**：macOS `launchctl` 默认软上限 `maxfiles = 256`。如果不显式配置 `SoftResourceLimits`/`HardResourceLimits`，`easytier-core` 运行一段时间后必然刷屏 `create v4 socket failed: Too many open files` 且 `easytier-cli` RPC 全部超时。**所有 macOS plist 必须配置 `NumberOfFiles = 65536`**。
2. **root LaunchDaemon 路径规范**：Mode A（TUN）以 root 跑在 `/Library/LaunchDaemons/` 时，二进制放 `/usr/local/bin/`、配置放 `/etc/easytier/config.toml`（`chmod 600`）、日志放 `/var/log/easytier/`，避免 macOS TCC/权限拦截 root 访问用户主目录。
3. **无 TUN 模式下的 Center / 双向 SSH**：Center 跑 Mode B（`no_tun = true` + `use_smoltcp = true`）时，如需从 Center 主动 SSH 连某台 Edge（如 `10.144.144.4:22`），可在 Center 配置增加 `[[port_forward]]`（`proto = "tcp"`, `bind_addr = "127.0.0.1:22004"`, `dst_addr = "10.144.144.4:22"`），无需给 Center 开 root TUN。
4. **多版本 Node.js 陷阱**：SSH 远程升级构建 HA 时，登录 shell 的 `nvm` 可能默认指向 Node 22，必须显式把 Node 24+（如 `/opt/homebrew/bin`）置于 `PATH` 最前。

### 3.3 Windows 专属铁律
- **目录规范**：统一放 `D:\software\easytier\`（日志放 `D:\software\easytier\logs\`）。
- **严禁直接用 `sc.exe create` 托管 `easytier-core.exe`**：缺少 Windows SCM 接口，启动 ~30 秒必报 **Error 1053**。必须用 **WinSW**（重命名为 `easytier-service.exe` 配 `templates/easytier-service.xml`）。
- **防火墙放行**：必须管理员权限为 `easytier-core.exe` 放行入站，否则 Defender 丢弃 UDP 打洞包退化为 `relay`。

### 3.4 Clash Verge / Mihomo TUN 共存铁律（macOS & Windows）
只要节点开启了 **Mode A（TUN）** 且运行 Clash Verge Rev / Mihomo TUN（`auto-route: true`）：
1. **必须在 Clash Verge 图形界面配置**（界面会接管并覆盖手工编辑的 `route-exclude-address`）：
   - 进入「设置 → 虚拟网卡模式（⚙）→ **排除自定义网段**」，逐条添加并保存：
     - `10.144.144.0/24`（EasyTier 虚拟网段）
     - `<RELAY_PUBLIC_IP>/32`（Relay 公网 IP，防止被代理接管出现假握手）
     - `<CENTER_SUBNET_PROXY_IP>/32`（如 Center 广播了子网代理 IP，例如 `10.211.55.2/32`）
   - 保存后如未生效，开关一次「虚拟网卡模式」即可刷新路由表。
2. **隐私说明**：`bind_device = true` 只让 `easytier-core` 走物理网卡，系统默认路由仍由 Mihomo 接管，不影响日常代理与 AI 流量。

### 3.5 HA 打包与 Windows 全量落盘（`flush`）铁律
1. **打包期严禁断连**：Center 处于 `phase=building_backup` 且 `cached.users === 1` 时，**严禁重启 EasyTier 或 HA daemon**，否则中止打包并清理临时目录。
2. **Windows NTFS `flush` 假死判活**：`phase=awaiting_ack` 解压后的同步递归 `fsyncSync` 可能阻塞 `ha` IPC 数十分钟。切勿强杀 daemon，改用以下三项判活：
   - 检查 `<viewRoot>\repos\<repoId>\views\<nodeId>\current.json` 是否生成；
   - 采样 `Win32_Process.OtherOperationCount` 是否持续递增；
   - 检查 `~/.harness/logs/daemon-default-diagnostics.jsonl` 的 `heartbeatAgeMs` 是否每 10 秒刷新。

---

### 入站端口白名单与按需调整

TUN 模式下，组网节点可以访问绑定到 `0.0.0.0` 的服务端口。`no_tun + use_smoltcp` 将入站连接代理到本机 `127.0.0.1`，所以仅监听回环的服务也需要白名单保护。四个接入模板默认仅允许 TCP 7545 和 18544 入站，UDP 入站列表为空。

将 `tcp_whitelist` 和 `udp_whitelist` 写在 TOML 顶层，放在第一个表头之前。EasyTier v2.6.4 的 `--check-config` 会静默忽略写入 `[flags]` 的白名单。每项可填写单端口 `"7545"` 或范围 `"8000-9000"`。修改后先用 `easytier-core --check-config -c <配置文件>` 校验，再重启对应服务以应用配置。

| 使用场景 | `tcp_whitelist` | `udp_whitelist` |
| --- | --- | --- |
| 默认 Center 能力 | `["7545", "18544"]` | `[]` |
| 纯 Edge，零入站 | `[]` | `[]` |
| 按需追加 TCP 端口，如 SSH | `["7545", "18544", "22"]` | `[]` |

纯公网 Relay 使用独立中继模板，负责转发组网流量。

## 4. 分平台部署流程

### Step 1：公网 Relay（Linux `systemd`）
1. 云安全组与本机防火墙放行 **TCP `11010`**、**UDP `11010`** 入站。
2. 安装 `easytier-core` 与 `easytier-cli`（`v2.6.4`）到 `/usr/local/bin/`。
3. 复制 `templates/relay-linux.toml` 到 `/etc/easytier/config.toml`（`chmod 600`），填入 `<RELAY_PUBLIC_IP>`、`<NETWORK_NAME>`、`<NETWORK_SECRET>`。
4. 复制 `templates/easytier-linux.service` 到 `/etc/systemd/system/easytier.service`（已含 `LimitNOFILE=65536`），校验并启动：
   ```bash
   sudo easytier-core -c /etc/easytier/config.toml --multi-thread true --bind-device true --check-config
   sudo systemctl daemon-reload && sudo systemctl enable --now easytier
   ```

### Step 2：Center 节点（macOS / Linux）
- **macOS Center（推荐 Mode B `no_tun` + `use_smoltcp`）**：
  1. 放置 `v2.6.4`（`aarch64`/`arm64`）到 `~/.local/bin/`，复制 `templates/center-macos-notun.toml` 到 `~/.config/easytier/config.toml`（`chmod 600`）。
  2. 复制 `templates/com.easytier.ha-center.plist`（含 `NumberOfFiles = 65536`）到 `~/Library/LaunchAgents/`，将其中的 `&lt;USER&gt;` 替换为本机短用户名，运行 `plutil -lint ~/Library/LaunchAgents/com.easytier.ha-center.plist` 后执行 `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.easytier.ha-center.plist`。
- **Linux Center（Mode A TUN 或 Mode B `no_tun`）**：使用 `templates/easytier-linux.service` 托管。
- **HA 服务端监听核查**：
  - Fleet TLS：确保 Center 以 `--bind 0.0.0.0` 启动；
  - Keycloak：若绑定在内网 IP（如 `10.211.55.2:18544`）以匹配证书 SAN，确保 Center 配置包含 `[[proxy_network]] cidr = "10.211.55.2/32"`。

### Step 3：Edge 节点部署（按系统选一）

#### A. macOS Edge（Mode A：TUN + root `LaunchDaemon`）
1. 准备 `v2.6.4` `easytier-core` / `easytier-cli` 到 `~/.local/bin/`（与 Center 同架构可直接 `scp`）。
2. 复制 `templates/edge-macos-tun.toml` 到 `~/.config/easytier/config.toml`（分配唯一 `ipv4` 如 `10.144.144.4` 与 `hostname`）。
3. 复制 `templates/install-macos-daemon.sh` 并以 `sudo bash install-macos-daemon.sh` 安装（自动装入 `/usr/local/bin`、`/etc/easytier`、`/Library/LaunchDaemons/com.easytier.ha-edge.plist`，带 `NumberOfFiles = 65536`）。
4. 若开有 Clash Verge，按 **3.4** 在界面排除 3 条网段。

#### B. Windows Edge（Mode A：TUN + WinSW）
1. 解压 EasyTier `v2.6.4` 与 WinSW `v2.12.0`（重命名为 `easytier-service.exe`）至 `D:\software\easytier\`。
2. 复制 `templates/edge-windows.toml` → `config.toml`、`templates/easytier-service.xml`、`templates/install-windows-service.ps1`。
3. 若开有 Clash Verge，按 **3.4** 在界面排除 3 条网段。
4. 管理员 PowerShell 执行：`powershell -ExecutionPolicy Bypass -File D:\software\easytier\install-windows-service.ps1`。

#### C. Linux Edge（Mode A：TUN + `systemd`）
1. 安装 `v2.6.4` 二进制到 `/usr/local/bin/`。
2. 复制 `templates/edge-linux-tun.toml` 到 `/etc/easytier/config.toml`（`chmod 600`），复制 `templates/easytier-linux.service` 到 `/etc/systemd/system/easytier.service`。
3. 校验并 `sudo systemctl enable --now easytier`。

### Step 4：对接 Harness Anything

#### 场景 0：单机 `local` 仓库原地升级为 EasyTier `remote-center`（无需 SQLite 转 PG）
HA Fleet Center 原生支持基于现有 SQLite 账本对外同步；`--mode managed` 会自动托管 Keycloak 及其内置 PostgreSQL，**无需执行 `ha migrate storage --from sqlite --to postgres`**。
1. **先备份与对齐版本**：先完成 `ha backup <仓库外备份目录>`，并确认 Center 与 Edge 运行一致的 HA commit（Node 24+）。
2. **启动托管登录服务并创建管理员**（密码仅通过受保护文件传入）：
   ```bash
   ha bootstrap --operation bootstrap --mode managed
   umask 077 && printf '%s' '<ADMIN_PASSWORD>' > /tmp/ha-admin-pass.txt
   ha bootstrap --operation bootstrap-admin \
     --person-id <person-id> --username <username> --email <email> --display-name '<name>' \
     --password-file /tmp/ha-admin-pass.txt
   rm -f /tmp/ha-admin-pass.txt
   ha bootstrap --operation login
   ```
3. **绑定 EasyTier 虚拟 IP 并签发自签 IP-SAN 证书**：
   > 若 Center 运行 Mode B（`no_tun + use_smoltcp`），宿主机不存在 EasyTier 虚拟网卡，**必须传 `--listen-address 0.0.0.0`**（由 `smoltcp` 转发入站流量）并传 `--hostname <CENTER_EASYTIER_IP>` 让 HA 自动生成包含该 IP SAN 的自签证书。
   ```bash
   ha bootstrap --operation listener --json   # 读取当前 version
   ha bootstrap --operation listener-set \
     --listen-address 0.0.0.0 \
     --hostname <CENTER_EASYTIER_IP> \
     --port 18544 \
     --certificate-mode self-signed \
     --expected-version <LISTENER_VERSION>
   ```
4. **切为 `remote-center` 并启动 Fleet TLS Center**（不传 `--key`/`--cert` 自动复用上一步的 Keycloak 证书）：
   ```bash
   ha daemon repo update --repo-id <repo-id> --mode remote-center
   ha daemon fleet center start \
     --port 7545 --bind 0.0.0.0 \
     --external-url https://<CENTER_EASYTIER_IP>:7545 \
     --repo <repo-id> --quota-bytes 10737418240
   ```

#### 场景 A：全新 Edge 设备首次接入
1. **对齐版本**：确认 Edge 的 `ha` 构建 commit 与 Center 一致（源码安装用 `scripts/install-source.sh --ref <CENTER_COMMIT>`）。
2. **Center 签发直连邀请**：
   - 添加本人另一台设备：
     ```bash
     ha bootstrap --operation edge-join-create --join-mode member-device --join-repo <repo-id> --transport direct --node-label <label>
     ```
   - 邀请新成员：先 `ha bootstrap --operation group-list --json` 查看权限组 ID，再通过 GUI「邀请成员加入」或执行：
     ```bash
     ha bootstrap --operation edge-join-create --join-mode invitation --transport direct \
       --person-id <person-id> --username <username> --email <email> --display-name '<name>' \
       --join-repo <repo-id> --join-group <group-id> --json
     ```
3. **Edge 执行加入**（注意：`--root <base-dir>` 是父目录，HA 会在其下按 `<base-dir>/<repoId>` 定位工作区；如果预先 clone 了仓库，请放到 `<base-dir>/<repoId>` 下，并加上 `--json` 便于核查每个仓库的同步回执。单台 Edge daemon 原生按 `sha256([issuer, realm])` 隔离不同 Center 的 OIDC 会话、按 `repoId` 隔离 `fleet-edge.json`，只要 `repoId` 不撞名，可直接加入多个不同 Center 而无需退登原账号）：
   ```bash
   ha edge join '<harness-edge://join/...>' --root <edge-base-dir> --json
   ```
   按提示在浏览器打开登录网址（`https://<CENTER_KEYCLOAK_IP>:<PORT>`），输入验证码批准登录，等待首次同步完成。若中途中断，重新执行同一条 `ha edge join` 即可自动走恢复路径，无需重签链接或重新登录。

#### 场景 B：旧 `ssh-reverse` 设备原地平滑迁移（零快照重拉）
1. 先备份 `<workspace>/fleet-edge.json` 到仓库外（如 `fleet-edge.json.ssh-bak`）。
2. 原地修改 `fleet-edge.json`（保留 `repoId`、`nodeId`、`credential`、`caPath`、`viewRoot`、`quotaBytes`、`servername`、`loginServername`、`loginCertificate` 不变）：
   - `host` → `"10.144.144.2"` 或 `"10.211.55.2"`
   - `port` → Center Fleet TLS 端口（如 `7545`）
   - `loginUrl` → `"https://<CENTER_KEYCLOAK_IP>:<KEYCLOAK_PORT>"`
3. 拉平默认分支并触发同步（**不要**在命令行传 `--host`/`--port`，否则 `persistEdgeConnection` 会忽略 `loginUrl` 变更）：
   ```bash
   git -C <workspace> fetch origin main && git -C <workspace> merge --ff-only origin/main
   ha daemon fleet edge sync --root <workspace> --timeout-ms 600000
   ```
4. 确认 `lag=0rev` + `Kcp` 稳定后，按需停用旧反向 SSH 隧道。若因重启 EasyTier 触发 `replica_duplicate_connection` 5 分钟退避，等 Center 回收旧连接后重启 Edge daemon 即可立即重连。

---

## 5. 验收与回退

```bash
# 1. 确认 P2P 直连（cost=p2p, tunnel=udp）及公网出口
easytier-cli node
easytier-cli peer
easytier-cli route

# 2. 确认 KCP 代理已接管 HA 复制连接（state=Connected, transport_type=Kcp）
easytier-cli proxy

# 3. 确认 Center Fleet TLS & Keycloak 连通（Edge 端）
curl -skI https://<CENTER_PROXY_IP>:<KEYCLOAK_PORT> | head -n 5

# 4. 确认 HA 同步状态（lag=0rev, delivery=delta, stream=connected）
ha daemon fleet status --root <workspace>
ha doctor --root <workspace>
```

**原地迁移回退**：将 `fleet-edge.json.ssh-bak` 覆盖回 `<workspace>/fleet-edge.json` 后执行 `ha daemon fleet edge sync --root <workspace>`。
