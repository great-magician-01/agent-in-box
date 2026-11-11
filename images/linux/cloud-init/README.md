# Cloud-init 使用说明（Guest Worker Runtime）

本说明覆盖两种 provisioning 路径：

1. **推荐：Golden Image 构建**——构建阶段在临时 Linux VM 内以 root 执行一次 `install.sh`，安装固定 Node/Pi/Worker、创建 `aib-worker` 并 `enable` 服务；镜像中不放 RPC token。VM 首次启动时由 Host 受控注入每 VM token，再启动服务。
2. **首次启动 cloud-init 安装**——镜像未预装 Worker 时，cloud-init 在首次启动调用 `install.sh`。这种方式需要 Guest 能访问 npm registry（或使用预置缓存），启动更慢、外部依赖更多。

两种路径都要求：

- `install.sh`、unit、`worker.env.example` 和三个包由**受控构建/部署流程**提供；
- 资产使用绝对路径，不能从 `/tmp`、当前目录或不可信下载目录执行；
- 安装脚本所在目录不能被 group/other 写（mounted ISO 只读挂载或 root-owned `0755` 目录均可）；
- SHA-256 来自构建 manifest，而不是 Guest 内现场生成；
- cloud-init 只注入**每 VM、短生命周期、可撤销的 Worker RPC token**；绝不注入 Provider API Key 或 Model Broker token。

示例见 [`worker-runtime.user-data.yaml.example`](worker-runtime.user-data.yaml.example)。

## 资产 staging

推荐把以下文件放到 root-owned、只读的 provisioning 目录
`/opt/agent-in-box/provision/`（可由只读 ISO 挂载，或由镜像构建阶段预置）：

```text
/opt/agent-in-box/provision/
├── install.sh
├── agent-in-box-worker.service
├── worker.env.example
├── node-v24.18.0-linux-x64.tar.xz
├── earendil-works-pi-coding-agent-1.5.1.tgz
├── agent-runtime-worker.tar.gz
└── SHA256SUMS                         # 构建侧生成的哈希清单
```

若使用 ISO，可让 Host 以只读方式挂载，例如：

```yaml
# 示例，设备名由 provisioning 替换；noexec 不影响 `bash /path/install.sh`
mounts:
  - [
      __PROVISION_DEVICE__,
      /opt/agent-in-box/provision,
      iso9660,
      "ro,noexec,nosuid,nodev,nofail",
      "0",
      "0",
    ]
```

不要把安装脚本 `curl | bash` 到 `/tmp` 后执行，也不要 `cd` 到下载目录再运行相对路径。示例统一使用：

```bash
bash /opt/agent-in-box/provision/install.sh ...
```

## 每 VM RPC token 的受控注入

Worker RPC token 与 Guest Agent token、Model Broker token 都不同：

- 只授权 Host → Worker RPC（7612）；
- per-VM 随机生成，Host 侧保存其副本用于 RpcClient；
- 不写入镜像、不提交仓库、不复用为 `models.json` 的 `apiKey`；
- 可撤销/轮换。

### 方式 A：安装时传入 staging 文件

1. Host 通过受控通道把 token 放到 Guest 的 root-only 临时路径，例如
   `/run/agent-in-box/rpc-token`，owner `root:root`，mode `0600`。
2. cloud-init 调用安装脚本时传入
   `--rpc-token-file /run/agent-in-box/rpc-token`。
3. 安装脚本原子复制到 `/var/lib/agent-in-box/worker/rpc-token`，owner
   `aib-worker`，mode `0600`。
4. cloud-init 删除 staging 文件，随后启动服务。

staging 文件必须是普通文件、非空、1–4096 字节、root-owned 且 group/other 无权限；安装脚本会拒绝其他形态。

### 方式 B：Golden Image 构建后注入

镜像构建阶段执行安装脚本但不传 token，也不启动服务。VM 首次启动后：

1. 通过 Host 控制的通道（QEMU `fw_cfg`、受认证 provisioning API、每 VM 独立 NoCloud seed 等）投递 token；
2. 以 root 原子写入目标文件，再 `chown aib-worker:aib-worker`、`chmod 0600`；
3. `systemctl start agent-in-box-worker.service`。

任一步失败时服务保持未启动或 fail closed。unit 的 `ConditionPathExists` 会避免在 token 缺失时进入失败重启循环；token 就绪后 `systemctl start` 即可。安装脚本不会自动生成替代 token。

### 通道安全说明

cloud-init 的 `write_files`/`runcmd` 内容会持久化在 Guest 的
`/var/lib/cloud/instance/` 下，通常仅 root 可读。它适合可随时撤销的每 VM RPC token，不适合长期秘密。生产优先使用不会把秘密写入可持久化 user-data 的通道，并在 VM 停止、任务结束或 token 轮换时撤销旧值。

## 首次启动安装流程

示例 user-data 的关键步骤是：

```yaml
runcmd:
  - |
    set -eu
    trap 'rm -f /run/agent-in-box/rpc-token' EXIT
    bash /opt/agent-in-box/provision/install.sh \
      --node-archive /opt/agent-in-box/provision/node-v24.18.0-linux-x64.tar.xz \
      --node-sha256 __NODE_TARBALL_SHA256__ \
      --pi-package /opt/agent-in-box/provision/earendil-works-pi-coding-agent-1.5.1.tgz \
      --pi-sha256 __PI_TARBALL_SHA256__ \
      --worker-bundle /opt/agent-in-box/provision/agent-runtime-worker.tar.gz \
      --worker-sha256 __WORKER_BUNDLE_SHA256__ \
      --unit-file /opt/agent-in-box/provision/agent-in-box-worker.service \
      --rpc-token-file /run/agent-in-box/rpc-token
    systemctl start agent-in-box-worker.service
```

`install.sh` 以 root 执行，但服务 unit 固定 `User=aib-worker`；安装脚本只 `enable`，模板显式 `start`。

若 Pi 安装需要 npm registry，首次启动必须能访问受控 registry 或使用预置 npm cache。生产 Golden Image 推荐在构建阶段完成安装，避免把首次启动成功与否绑定到外网可用性。

## 验证

```bash
systemctl is-enabled agent-in-box-worker.service
systemctl status agent-in-box-worker.service
ss -ltn '( sport = :7612 )'
test -f /var/lib/agent-in-box/worker/rpc-token
stat -c '%U %a %n' /var/lib/agent-in-box/worker/rpc-token
# 期望: aib-worker 600 /var/lib/agent-in-box/worker/rpc-token
```

若服务启动失败，优先检查：

- token 文件是否存在、是否为普通文件、owner/mode 是否正确；
- worker bundle 的 `dist/worker-rpc-main.js` 与已安装 Node 是否匹配；
- unit 日志：`journalctl -u agent-in-box-worker.service -n 100 --no-pager`；
- unit 的 `ProtectSystem`/`ReadWritePaths` 是否覆盖了实际 workspace/session 路径。

## 禁止事项

- 不在 user-data、meta-data、镜像层、环境变量或 `worker.env` 中放 Provider API Key；
- 不把 Model Broker token 写进 cloud-init 或镜像；它只应出现在每 session HOME 的 `.pi/agent/models.json`；
- 不复用 Guest Agent token 或 Worker RPC token 作为 Broker token；
- 不从不可信当前目录、世界可写目录或未校验下载内容执行安装脚本；
- 不在 Guest 网络可达的不可信接口上暴露 7612。
