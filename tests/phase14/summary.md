# 阶段 14：模型多配置、只读观察与一键 Linux VM 验收记录

日期：2026-11-12

## 结论

本轮在不修改数据根/存储迁移实现的前提下，完成了模型多配置、Codex 式三栏工作区、只读 VM 观察、Electron 托管 VM Supervisor/QEMU，以及 Ubuntu 官方镜像 cloud-init 一键初始化。

`pnpm check`、全部阶段 2～13 Smoke、`pnpm smoke:phase14`、`pnpm package:vm-supervisor` 与 `pnpm package:guest-runtime` 已在当前 WSL/Linux 开发环境执行。

## 已自动化

1. **模型多配置**：`model-provider.service.test.ts` 覆盖多 Provider、显式选择、禁用和模型白名单；`router-runtime.service.test.ts` 覆盖 Router 空闲切换、清空 session_ref、新模型启动新会话和运行中拒绝切换。
2. **只读观察**：`console.service.test.ts` 验证 view-only 不调用 `leases.acquire`、无需 human Lease 即可升级、丢弃 KeyEvent/PointerEvent/ClientCutText、仅转发 FramebufferUpdateRequest。
3. **Provisioning**：`provisioning.service.test.ts` 覆盖 HMAC token、非法 token 403、路径穿越 404、per-VM token、ready 后 410 和失败状态；`vm.service.test.ts` 覆盖 token 生成与 `provisioningUrl` 传递。
4. **QEMU 托管下载**：`qemu-toolchain.test.ts` 覆盖自定义/托管路径、下载 SHA-256、tar 安装和哈希失败。
5. **Go Provider**：新增 Linux `-smbios ...nocloud-net` 参数测试，并断言 Windows 不包含该参数；VNC 参数允许 shared 观察。
6. **阶段 14 Smoke**：真实控制平面、SQLite、Provisioning HTTP 服务和 `release/guest-runtime/linux-amd64` 资产，4 项检查通过：
   - Provider 与 Worker/Router 选择持久化；
   - Router 空闲切换模型并保留设置；
   - user-data 包含桌面/Agent/Worker 初始化且不泄漏 Guest Token；
   - ready 后撤销 bootstrap 数据并更新 VM 状态。

## 验证边界

- 未在当前 WSL 环境验证 Windows 11 + WHPX、真实 QEMU 启动、cloud-init 首次启动、XFCE 桌面、Worker RPC、Electron/浏览器人工 UI 或 NSIS 安装。
- QEMU 托管下载依赖发布资产 `runtime-assets.json`；未发布时 UI 会明确报错。开发环境可用 `AGENT_IN_BOX_RUNTIME_MANIFEST` 指向本地/自建 Manifest。
- 官方镜像首次初始化需要 Guest 访问 apt 与 npm registry；完全离线环境需要额外的 Golden Image 或预置缓存方案。
- 存储迁移未纳入 `tools/qemu/` 与 `provisioning.key`；本轮明确不处理迁移。

## 复现

```bash
pnpm check
pnpm smoke:phase14
pnpm package:vm-supervisor
pnpm package:guest-runtime
```

真实环境验收步骤见 [`README.md`](../../README.md) 与 [`docs/04-user-guide.md`](../../docs/04-user-guide.md)。
