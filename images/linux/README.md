# Linux Guest 镜像资产

本目录提供阶段 6 的 Guest Worker Runtime 安装资产。它们只被构建机或受控 provisioning 使用，不假定 Guest 内存在本仓库；安装脚本只消费显式绝对路径的外部产物。

## 固定版本

| 组件           | 版本/来源                               | 约束                                                               |
| -------------- | --------------------------------------- | ------------------------------------------------------------------ |
| Node.js        | `24.18.0`                               | 官方 Linux 归档，安装后校验 `node --version == v24.18.0`           |
| Pi             | `@earendil-works/pi-coding-agent@1.5.1` | 使用显式 npm tarball；安装后校验 package version 和 `pi --version` |
| Worker Runtime | `packages/agent-runtime` 构建产物       | 自包含 `.tar.gz`，归档根含 `dist/worker-rpc-main.js`，CommonJS     |
| RPC 监听       | Guest 内 `0.0.0.0:7612`                 | Host 侧转发必须只绑定回环/受控地址                                 |
| 运行用户       | `aib-worker`                            | 非特权、无 sudo、服务进程永不 root                                 |
| 工作目录       | `/home/aib-worker/workspace`            | `aib-worker:aib-worker`，`0750`                                    |
| 会话根         | `/var/lib/agent-in-box/worker/sessions` | `aib-worker:aib-worker`，`0700`                                    |

Provider 长期 Key、Model Broker 令牌和 RPC Bearer 令牌**都不会**被打进镜像；安装脚本不生成、不读取、不写死任何 Provider Key。

## 文件

```text
images/linux/
├── README.md
├── cloud-init/
│   ├── README.md                    # cloud-init 使用说明
│   └── worker-runtime.user-data.yaml.example
└── worker-runtime/
    ├── install.sh                   # 仅 root 执行一次的安装脚本
    ├── agent-in-box-worker.service  # systemd unit
    └── worker.env.example           # 可选运行环境示例
```

安装脚本需要与 unit、`worker.env.example` 同目录（或通过 `--unit-file` 显式指定 unit）。所有二进制/包路径必须由调用方显式传入，脚本不会从当前工作目录加载或执行任何文件。

## Worker Bundle 契约

`packages/agent-runtime` 的打包流程应产出类似：

```text
agent-runtime-worker.tar.gz
├── dist/worker-rpc-main.js      # 必填，CommonJS，自包含入口
├── package.json                 # 可选/建议
└── node_modules/...             # 自包含依赖，若有
```

约束：

- 入口必须位于归档根部的 `dist/worker-rpc-main.js`，不能是符号链接；
- 必须是可在固定 Node 24.18.0 下运行的 CommonJS；
- 必须自包含，不能依赖 Guest 上的仓库、workspace 包或额外 `npm install`；
- 不能包含 token、`models.json`、Provider Key 或其他秘密；
- 构建侧生成 SHA-256，并在 provisioning manifest 中固定。

安装脚本会在 root-only staging 目录中解包、检查入口、执行 `node --check`，然后按内容哈希安装到 `/opt/agent-in-box/worker-releases/<sha256>`，并通过 `/opt/agent-in-box/worker` 符号链接启用。

## 构建/准备产物

构建机负责准备并固定哈希：

```bash
# Node 官方归档（版本必须为 24.18.0；示例为 x64，arm64 Guest 使用对应官方归档）
# https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz

# Pi 固定 npm tarball
npm pack @earendil-works/pi-coding-agent@1.5.1

# Worker 自包含包由 packages/agent-runtime 的阶段 6 打包流程生成
# 产物必须满足上面的 bundle 契约

sha256sum node-v24.18.0-linux-x64.tar.xz \
          earendil-works-pi-coding-agent-1.5.1.tgz \
          agent-runtime-worker.tar.gz
```

Pi 安装使用 `npm install --global --prefix ... --ignore-scripts`。Pi 1.5.1 及其当前依赖不需要安装期生命周期脚本；如果未来版本需要，必须在受控构建阶段预先生成自包含产物，而不是放宽 Guest 内的 root 安装脚本执行策略。依赖仍由 npm registry 解析，因此生产 Golden Image 应在受控构建时安装，避免首次启动依赖外网。

## 安装

在启用了 systemd 的 Linux Guest 内以 root 执行一次（`__...__` 占位符由构建 manifest 填入，必须是 64 位十六进制）：

```bash
sudo -i   # 或由 cloud-init/镜像构建器以 root 调用

bash /opt/agent-in-box/provision/install.sh \
  --node-archive /opt/agent-in-box/provision/node-v24.18.0-linux-x64.tar.xz \
  --node-sha256 __NODE_ARCHIVE_SHA256__ \
  --pi-package /opt/agent-in-box/provision/earendil-works-pi-coding-agent-1.5.1.tgz \
  --pi-sha256 __PI_PACKAGE_SHA256__ \
  --worker-bundle /opt/agent-in-box/provision/agent-runtime-worker.tar.gz \
  --worker-sha256 __WORKER_BUNDLE_SHA256__ \
  --unit-file /opt/agent-in-box/provision/agent-in-box-worker.service \
  [--rpc-token-file /run/agent-in-box/rpc-token] \
  --cua-extension /opt/agent-in-box/provision/cua-extension.js
```

阶段 7 起，真实 Computer Use Worker 需要安装 `worker-runtime/cua-extension.js`（构建时复制到 provision 目录）；它只使用 Host 会话注入的 `AGENT_IN_BOX_CUA_URL/TOKEN`，不读取 Guest Agent token。

安全规则：

- 所有参数路径必须是绝对路径；
- 安装脚本所在目录不能是 group/other 可写（拒绝直接从 `/tmp` 这类目录执行）；
- 输入会先复制到 root-only staging 并校验 SHA-256，再从 staging 解包/安装；
- 归档中不允许绝对路径或 `..` 路径穿越；
- 安装前校验 unit：必须 `User/Group=aib-worker`、唯一 `ExecStart`、`NoNewPrivileges=true`、空 capability 集，并拒绝 `PermissionsStartOnly`、额外 `Exec*` 或补充用户组；
- 脚本检测到 Node/Pi 版本不匹配、校验失败、用户/目录异常、systemd 启用失败时，以非零退出码明确失败：
  `2` 用法/路径、`3` 权限/平台、`4` 输入/归档、`5` 校验和、`6` 版本、`7` 安装/状态、`8` systemd；
- 脚本只 `enable` 服务，不自动 `start`。token 就绪后再启动；unit 的 `ConditionPathExists` 保证缺失 token 时不会进入失败重启循环。
- 脚本要求 systemd 正在运行（检查 `/run/systemd/system`），应在已启动的临时构建 VM 或首次启动的 Guest 内执行，不要在 chroot/virt-customize 离线阶段直接执行。

安装脚本创建或校验：

```text
/opt/agent-in-box/node-24.18.0 -> /opt/agent-in-box/node
/opt/agent-in-box/pi-1.5.1     -> /opt/agent-in-box/pi
/opt/agent-in-box/worker-releases/<sha256> -> /opt/agent-in-box/worker
/opt/agent-in-box/extensions/cua-extension.js       # 仅 --cua-extension
/opt/agent-in-box/install-manifest.json             # 版本和哈希审计
/etc/agent-in-box/worker/worker.env                 # 不含秘密
/etc/systemd/system/agent-in-box-worker.service
/var/lib/agent-in-box/worker/rpc-token              # 若已 provisioning
/var/lib/agent-in-box/worker/sessions
```

`install-manifest.json` 只记录 Node/Pi 版本、三个产物的 SHA-256、worker 入口、RPC 地址、服务用户和 token 文件路径，不包含令牌值。

## 运行语义

systemd unit 固定以下环境：

| 变量                             | 值                                                                       |
| -------------------------------- | ------------------------------------------------------------------------ |
| `AGENT_IN_BOX_WORKER_TOKEN_FILE` | `/var/lib/agent-in-box/worker/rpc-token`                                 |
| `AGENT_IN_BOX_PI_BINARY`         | `/opt/agent-in-box/pi/bin/pi`                                            |
| `AGENT_IN_BOX_SESSION_ROOT`      | `/var/lib/agent-in-box/worker/sessions`                                  |
| `AGENT_IN_BOX_WORKER_HOST`       | `0.0.0.0`（Guest 内监听；Host 侧转发必须回环）                           |
| `AGENT_IN_BOX_WORKER_PORT`       | `7612`                                                                   |
| `AGENT_IN_BOX_CUA_EXTENSION`     | 可选；通过 `/etc/agent-in-box/worker/worker.env` 或安装脚本 drop-in 设置 |

Unit 以 `User=aib-worker`、`Group=aib-worker` 运行，`WorkingDirectory=/home/aib-worker/workspace`，并启用 `NoNewPrivileges`、空 capability 集、`ProtectSystem=strict`、`ProtectHome=read-only`、只对 workspace 和 worker state 目录开放写权限。`PATH` 固定包含 `/opt/agent-in-box/node/bin`，保证 Pi 的 `#!/usr/bin/env node` 使用固定 Node，而不是 Guest 上任意 Node。Unit 的 `HOME=/home/aib-worker` 仅作为服务进程基础环境；Worker RPC 必须为每个 Pi 子进程把 `HOME` 覆盖为 `<AGENT_IN_BOX_SESSION_ROOT>/<workerId>/home`。

Worker 进程监听 `0.0.0.0:7612`：unit 显式设置 `AGENT_IN_BOX_WORKER_HOST/PORT`，由 `dist/worker-rpc-main.js` 实际绑定。该地址只应在 Guest 内可达；QEMU user-mode 网络的主机转发必须绑定 `127.0.0.1`，Guest 网络不得桥接到不可信 LAN。若 Guest 内存在其他用户，应只允许预期 Host 网关访问 7612。

## 三类令牌必须分离

| 令牌               | 用途                                         | 存放/生命周期                                                                                                                 |
| ------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Guest Agent token  | Host 控制平面 → Guest Agent（7611）          | 独立文件，按既有 Guest Agent provisioning 注入；不是 Worker RPC token                                                         |
| Worker RPC token   | Host 控制平面/RpcClient → Worker RPC（7612） | `/var/lib/agent-in-box/worker/rpc-token`，普通文件，owner `aib-worker`，mode `0600`，每 VM 独立、可轮换/撤销                  |
| Model Broker token | Guest 内 Pi → Host Model Broker              | 每 session 短期令牌，由 Host 在 session 启动时提供，Worker RPC 写入每 session HOME 的 `.pi/agent/models.json`，不是 RPC token |

### Worker RPC token 的受控注入

- token 必须由 Host 侧控制平面在 VM 创建/启动流程中随机生成，high-entropy、per-VM，并保存在 Host 的受保护状态中；它只授权 Worker RPC，**不是** Provider Key，也**不是** Model Broker token。
- 方式 A：先写入 root-only staging 文件（owner root，mode `0600`），再把它作为 `--rpc-token-file` 传给安装脚本。安装脚本原子复制为 `/var/lib/agent-in-box/worker/rpc-token`（owner `aib-worker`，mode `0600`），然后 provisioning 删除 staging 文件。
- 方式 B：Golden Image 构建时先安装但不启动服务；VM 首次启动后通过受控通道原子替换目标文件，再 `systemctl start agent-in-box-worker.service`。
- 推荐使用 QEMU `fw_cfg`、受认证的 provisioning API 或每 VM 独立的 NoCloud seed 等受控通道，而不是把 token 提交到仓库、写进镜像或长期保留在普通 cloud-init user-data 中。cloud-init 的 instance user-data 会持久化在 Guest 内，只有短生命周期、可撤销的每 VM RPC token 才可作为兜底方案。
- 轮换/撤销：Host 原子替换或删除文件；Worker RPC 按每个请求重新读取该文件，替换后旧 token 立即失效，删除后请求失败关闭（当前 `worker-rpc-server` 即为此语义）。
- 目标文件必须是普通文件而非符号链接，大小 1–4096 字节；安装脚本会校验。
- unit 使用 `ConditionPathExists=/var/lib/agent-in-box/worker/rpc-token`：token 尚未注入时 systemd 不会启动或反复重启服务；注入后执行 `systemctl start agent-in-box-worker.service`。

### Model Broker token 的每 session 写入

- 安装脚本和镜像**不创建**任何 `models.json`。镜像中不存在长期模型凭据。
- Host 在 session 启动时通过 session spec 提供短期 Model Broker 凭据（`modelBroker.baseUrl/token/provider/model/api`）；Worker RPC 将该 session 的 `HOME` 指向 `<AGENT_IN_BOX_SESSION_ROOT>/<workerId>/home`，并原子写入：
  `.../home/.pi/agent/models.json`
- 该文件只包含本地 Broker `baseUrl` 和短期 token/模型配置，原子写入时 mode `0600`，不得包含上游 Provider API Key；session 归档/释放时删除该文件。
- RPC token 与 Broker token 不能复用同一个值或同一个文件；`models.json` 的 `apiKey` 必须是 Broker token，不是 RPC token。session manifest 的持久化 spec 会剔除 `modelBroker`，不把 broker token 写入会话归档。
- session 结束、撤销或 VM 停止时应删除该文件；Worker/归档不得把 token 写入日志、任务事件或长期会话归档。

## 启动与验证

```bash
# token 已受控注入后
systemctl start agent-in-box-worker.service
systemctl status agent-in-box-worker.service
ss -ltn '( sport = :7612 )'
journalctl -u agent-in-box-worker.service -n 100 --no-pager
```

只读检查：

```bash
bash -n images/linux/worker-runtime/install.sh
systemd-analyze verify images/linux/worker-runtime/agent-in-box-worker.service
```

`systemd-analyze verify` 在开发机上可能因缺少 `aib-worker` 用户或 `/opt/agent-in-box` 产物而给出提示；Guest 内安装完成后应无此类缺失。

## 升级与卸载

- 升级：用新的 Worker bundle、Node/Pi 产物和哈希重新执行安装脚本；安装脚本替换版本化目录、更新符号链接并重新 `enable`。运行中的旧服务需要手动 `systemctl restart`，因为安装脚本默认不再启动/重启服务。旧 worker release 目录保留在 `/opt/agent-in-box/worker-releases/`，便于人工回滚。
- 本阶段不提供 uninstall 脚本。确需移除时，至少先 `systemctl disable --now agent-in-box-worker.service`，再删除 unit、`/opt/agent-in-box`、`/etc/agent-in-box/worker`、`/var/lib/agent-in-box/worker` 和 `aib-worker` 用户；不要把 token/模型文件留在镜像或云盘快照中。

## 已知边界

- 本目录只提供安装/运行资产，不实现 Worker RPC 协议、Session Format 版本检查、Model Broker 或 Host 侧 token 签发。这些由阶段 6 的 `packages/agent-runtime`、控制平面和 provisioning 流程实现。
- Pi 的依赖来自 npm registry；真正可离线复现的 Golden Image 必须在受控构建阶段完成安装并把产物/校验和固化到部署 manifest。
- Worker bundle 默认包含并加载 `subagent` 扩展（`scout`、`planner`、`reviewer`、`worker`），子 Pi 进程继承当前模型、工作区、工具限制与项目 MCP 开关，但不会递归加载 subagent 或自动发现项目扩展。已有镜像/VM 需要更新 Worker Runtime 并新建或恢复会话后使用该能力。
- MCP 由 Host 的项目设置按项目开启，默认仍为 `--no-mcp`。开启后 Pi 可读取该 Worker 隔离 HOME 的 `.pi/agent/mcp.json`；工作目录 `.pi/mcp.json` 仍受 Pi 项目信任机制约束，Agent-in-Box 不会自动提升信任或注入 Server 凭据。
- CUA extension 是 GUI Worker 的必需件（安装参数仍可选，便于无桌面的普通 Worker）；`--cua-extension` 只复制单个自包含文件，extension 其余依赖必须由 Pi 安装或 extension 自身提供。阶段 7 的 [`worker-runtime/cua-extension.js`](worker-runtime/cua-extension.js) 只调用 Host Computer Use Broker（`AGENT_IN_BOX_CUA_URL/TOKEN`，由 Host session spec 注入），**不读取 Guest Agent token**。Guest Agent token 与 RPC token、Model Broker token、CUA Broker token 均不同；不要把任一 token 写进镜像。
- 阶段 7 的 Computer Use 依赖宿主控制平面的 CUA Broker（默认回环 `6720`）和 Guest 侧安装该 extension。未安装 extension 时 Pi 只有通用工具，不能执行 GUI 动作；CUA Broker 仍会拒绝无 Lease/无观察/过期截图的请求。
