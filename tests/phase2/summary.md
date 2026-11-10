# 阶段 2 验收记录（2026-11-10）

> 范围：Electron、本地服务和自定义存储。记录区分“本环境已实测”“仅自动化/代码验证”和“未关闭门槛”，不以 TypeScript 构建通过代替桌面或 Windows 安装验证。

## 环境

- 开发/验证主机：Windows 11 宿主机内的 WSL2（Linux 6.6.114.1-microsoft-standard-WSL2），Node.js 24.18，pnpm 11.22，Go 1.26
- Electron：45.2.3（通过 `npmmirror` 下载二进制）
- 目标发布环境：Windows Host；本阶段未获得干净 Windows 构建机
- WSL 运行 Electron 需要 WSLg/X 以及 `libnspr4`、`libnss3`、`libasound2`；这些是环境依赖，不进入安装包

## 2.1 无特权 Electron 壳

| 验收项                                  | 状态                      | 证据                                                                                                                                                                                                             |
| --------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron 加载共用 React 前端            | 通过                      | 打包后 Smoke Test 的页面文本包含“首次启动向导”“环境检查”，说明 React + Vite 构建产物已由本地 Control Plane 同源提供                                                                                              |
| Renderer 无 Node 任意执行               | 通过                      | 打包 Smoke Test 在页面主世界读取到 `typeof require === "undefined"`、`typeof process === "undefined"`；`webPreferences.sandbox=true`、`contextIsolation=true`、`nodeIntegration=false`                           |
| Renderer 不能直接访问 Supervisor        | 通过                      | preload 只暴露 `app/dialog/config/credentials/log` 白名单方法；没有通用 `invoke`、文件系统或命令执行通道；IPC 侧校验发送页面来源                                                                                 |
| 本地服务启动、健康检查和异常提示        | 通过（单元 + 打包 Smoke） | `ControlPlaneSupervisor` 启动、健康轮询、启动超时、异常退出、自动重启上限均有测试；打包 Smoke 中 Control Plane 在约 1 秒内 healthy，`ipcState=running`；Electron 加载失败时显示本地诊断页并支持重启/打开日志     |
| 关闭窗口与退出后台服务不同行为          | 通过（单元/配置）         | 关闭行为持久化到共享 `app-config.json`；选择后台运行时窗口隐藏到托盘，选择退出时停止 Control Plane；托盘不可用时强制退出避免无入口后台进程。无头环境未对真实鼠标关闭做端到端点击                                 |
| 基础日志和崩溃诊断                      | 通过（单元/代码）         | JSONL 日志、密钥字段脱敏、5 MB 轮转；`uncaughtException`、`unhandledRejection`、Renderer/GPU 崩溃写入日志并提示。未做真实崩溃注入                                                                                |
| electron-builder 对 pnpm Workspace 打包 | 部分通过                  | Linux `--dir` 安装目录和 Windows `win-unpacked`、portable exe 构建成功；Control Plane 通过 `pnpm deploy` + `runtime_modules` + `NODE_PATH` 自包含。**NSIS 安装包与干净 Windows 运行未验证**（Linux/WSL 无 wine） |

打包 Smoke Test 结果：

```json
{
  "ok": true,
  "controlPlane": { "state": "running", "protocolVersion": "0.1.0" },
  "renderer": {
    "bridge": "object",
    "requireType": "undefined",
    "processType": "undefined",
    "ipcState": "running",
    "text": "…首次启动向导…环境检查…"
  }
}
```

## 2.2 首次启动向导

| 验收项                                | 状态                    | 证据                                                                                                                                                                                                             |
| ------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 检查 CPU 虚拟化、操作系统、内存和磁盘 | 通过（WSL 实测 + 单元） | `GET /api/v1/host/inspection` 返回 4 项检查；真实 WSL 返回 OS 警告、CPU 虚拟化通过、内存通过、磁盘警告；Windows PowerShell 输出解析、无虚拟化/未知阻断、阈值边界均有测试。Windows 真机 PowerShell 探测本轮未重跑 |
| 第一次下载前选择存储位置              | 通过                    | 向导存储步骤先校验路径；`pnpm smoke:phase2` 在完成向导前完成目录创建、可写探测和空间检查，完成后才进入主界面                                                                                                     |
| 非系统盘、空格和 Unicode 路径         | 通过（Linux）           | 自动化测试使用 `data 根目录`、`新的 数据 目录`；API Smoke 使用 `目标 数据 目录`。Windows 非系统盘路径沿用阶段 0 的 ASCII/Unicode/junction 验证                                                                   |
| Host Reserve 和自动启动策略           | 通过                    | 持久化到 `app_settings`；API Smoke 验证 2 GiB reserve；向导和设置页可修改；输入范围校验有测试                                                                                                                    |
| 模型凭据保存到 OS 安全存储            | 通过（适配层测试）      | Electron Main `CredentialStore` 使用 `safeStorage`；文件只保存密文；Linux `basic_text`、加密不可用、非法 Provider、过长/过短密钥均拒绝；未在真实 Windows DPAPI/Keychain 上实测                                   |
| 长期密钥不写普通配置/日志             | 通过                    | 凭据文件只含 base64 密文；日志对 `secret/token/password/apiKey/authorization` 脱敏；Control Plane 只接收 `credentialsConfigured` 元数据                                                                          |
| 创建本地管理员/用户身份和安全设置     | 通过                    | `local_users` 保存本机管理员显示名与角色；`app_settings` 保存敏感操作审批；API 和数据库测试覆盖                                                                                                                  |

## 2.3 Storage Manager

| 验收项                              | 状态     | 证据                                                                                                                                                             |
| ----------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 统一管理镜像/下载/VM/快照/产物/归档 | 通过     | `StorageService` 统一解析 `<root>/{images,downloads,vms,snapshots,artifacts,archives}`；`/api/v1/runtime`、`/api/v1/storage` 返回分类路径和占用                  |
| 空间与权限检查                      | 通过     | 可写探测、`statfs`、磁盘根目录/相对路径/文件路径拒绝、只读目录报错、Unicode/空格、符号链接解析均有测试                                                           |
| 路径变更事务和存储锁                | 通过     | 锁文件记录 owner/pid/host/operation；并发操作返回 conflict；同机死进程锁可恢复；迁移复制阶段持有锁                                                               |
| 基础迁移流程                        | 通过     | 逐文件 SHA256 + 大小校验、SQLite 在线备份 + `integrity_check`、成功后才原子更新配置；失败保持旧配置并清理本次创建的空目标目录                                    |
| 迁移失败仍可使用旧路径              | 通过     | 测试注入符号链接使复制失败，旧目录文件、旧数据库和配置均保持不变，审计状态为 failed                                                                              |
| 迁移后 VM/快照链完整性              | 部分通过 | 当前无真实 VM 数据；实现了可选 `qemu-img check` 和 backing file 旧路径警告；测试数据覆盖 vms/snapshots 目录复制。真实 qcow2 链迁移待阶段 3 VM 生命周期接入后复测 |
| 清理下载缓存不删除 VM/项目          | 通过     | `cleanup-downloads` 只清理 `downloads/`；测试验证 `vms/disk.qcow2`、`artifacts/result.txt` 保留                                                                  |

## 自动化与 Smoke 测试

本阶段新增：

- Control Plane：宿主检查、存储校验/迁移/锁/清理、Onboarding/Settings、迁移 002，共 41 个 Vitest 测试
- Electron：日志脱敏/轮转、共享配置、凭据存储、Control Plane 监管、关闭行为，共 16 个 Vitest 测试
- Config：应用配置位置/原子写/数据根解析/Unicode 路径，共 14 个 Vitest 测试
- 全仓库合计 123 个 Vitest 测试和全部 Go 测试通过
- `pnpm smoke:phase2`：真实启动 Control Plane，完成向导、迁移、重启对账
- `pnpm smoke:desktop`：启动打包后的 Electron，验证 Renderer 隔离、preload IPC、Control Plane healthy 和向导渲染

## 未关闭门槛

1. **Windows 干净环境安装包**：NSIS 需要 Windows 或 wine；当前 Linux/WSL 只完成 `win-unpacked`/portable。必须在 Windows 构建机生成安装包并完成安装、首次启动、卸载 Smoke Test。
2. **Windows 真机宿主检查与 DPAPI**：Windows PowerShell 虚拟化探测和 `safeStorage` 实际后端尚未在本阶段复测。
3. **真实 qcow2 迁移**：qemu-img 校验、backing file 路径重写和 VM 停机协调待阶段 3 接入真实 VM 后完成。
4. **本地 API 认证**：当前依赖回环监听、Host 白名单和 CORS；完整本机 Web 认证/CSRF 属于阶段 11～12。
5. **崩溃注入与长稳**：未做 Electron/Control Plane/Renderer 真实崩溃和长时间运行测试。
6. **凭据管理入口**：首次启动向导可以安全保存/删除凭据；向导之外的完整凭据管理与凭据使用链（Model Broker）在阶段 6 实现。当前不向 VM 或控制平面暴露明文。

## 阶段出口判断

阶段 2 的核心产品化能力、自动化测试和 Linux 打包链路已完成，可以进入阶段 3。Windows NSIS 安装包、干净 Windows Smoke Test 和真实 qcow2 迁移作为显式验收门槛保留，不因 Linux 打包通过而宣称 Windows 安装已验证。
