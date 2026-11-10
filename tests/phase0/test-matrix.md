# 阶段 0 测试矩阵

> 目标：在开发大规模产品功能前，固定验证环境，优先证明 Windows Host 运行 Linux Guest 的 P0 路径。

## 1. 宿主机档位

| ID | 环境 | Hypervisor 路径 | 优先级 | 当前状态 |
| --- | --- | --- | --- | --- |
| H1 | Windows 11 家庭版 26200，Intel Core Ultra 5 225H，14 逻辑核，33 GB | QEMU 11.1.3（MSYS2 UCRT64）+ WHPX | P0 | 2026-11-10 已通过 G1 启动、SSH、优雅关机、快照恢复 |
| H2 | Windows 11 专业版/企业版，支持 Hyper-V | Hyper-V Provider | P1 | 待真实环境 |
| H3 | Windows 10 22H2，无 Hyper-V 管理器 | QEMU + WHPX | P1 | 待真实环境 |
| H4 | Linux/WSL2，暴露 `/dev/kvm` | QEMU + KVM | 开发辅助 | 不作为 P0 替代结论 |

记录要求：操作系统精确版本、CPU、逻辑核数、物理内存、虚拟化固件状态、WHPX/Hyper-V 能力、QEMU 版本、可用磁盘。

## 2. Guest 与镜像

| ID | Guest | 用途 | 镜像要求 |
| --- | --- | --- | --- |
| G1 | Ubuntu 24.04 Server cloud image | Hypervisor、网络、启动与生命周期验证 | 官方镜像 + SHA256；cloud-init NoCloud |
| G2 | Ubuntu 24.04 桌面 Golden Image | Computer Use、中文输入、浏览器与办公任务 | 固定桌面栈、Guest Agent、非特权 Worker 用户 |
| G3 | Debian 12 桌面（备选） | 默认桌面栈不可用时的对比验证 | 仅 G2 验证失败后启用 |

Windows Guest 镜像只允许提前下载与校验；在 Linux 全链路验收前不得创建或验证 Windows VM。

## 3. VM 资源档位

| ID | vCPU | 内存 | 覆盖盘 | 用途 |
| --- | --- | --- | --- | --- |
| R1 | 2 | 2 GB | 20 GB | Hypervisor 最小可行验证 |
| R2 | 4 | 4 GB | 40 GB | 默认桌面与 Computer Use 基线 |
| R3 | 4 | 8 GB | 60 GB | 浏览器 + 开发工具长任务 |

资源不足时记为 `environment_error` 或排队等待，不得因此限制用户可创建/保留的 VM 数量。

## 4. 验证分组

| 分组 | 内容 | 对应计划 |
| --- | --- | --- |
| V-HOST | CPU 虚拟化、WHPX/Hyper-V、QEMU、内存、磁盘、权限检测 | 0.2 |
| V-LIFE | 创建、启动、登录、停止、重启、快照、Supervisor 崩溃接管 | 0.2 |
| V-IMG | 分块下载、续传、校验、原子启用、自定义存储路径 | 0.3 |
| V-CUA | 截图、输入、工具循环、取消、恢复、长会话 | 0.4、7 |
| V-NET | Model Broker 流式/图片/工具/取消；飞书/QQ 长连接与去重 | 0.5 |

## 5. 通过标准

- P0：H1 或等价干净 Windows Host 上，至少一条 Provider 路径能重复完成 G1 的创建、启动、停止和快照；随后 G2 完成核心 Computer Use 任务。
- 不支持的环境必须由 Host Inspect 明确报错，不得无响应或误报 Ready。
- 单次演示不能作为稳定性结论；结果写入 `results/` 并引用证据。
