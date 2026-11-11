# 存储与备份指南

> 适用版本：0.1.0 阶段 13 代码与自动化构建（Linux/Windows Guest）

## 1. 目录布局

小体积配置保存在 OS 配置目录；大文件位于用户选择的数据根目录：

```text
<data-root>/
  images/          已校验的镜像和基础盘
  downloads/       镜像/更新下载缓存，可清理
  vms/<vm-id>/     每台 VM 的覆盖盘、令牌和运行记录
  snapshots/<vm-id>/  整机快照元数据/数据
  artifacts/       任务产物（服务端校验 SHA-256）
  archives/        Worker 归档引用（JSONL 等）
  inbox/           文件投递上传内容
  backups/         数据库迁移前备份（pre-migration-*.sqlite）
  agent-in-box.sqlite
```

配置文件位置：

- Windows：`%APPDATA%\AgentInBox\app-config.json`
- Linux：`~/.config/agent-in-box/app-config.json`
- macOS：`~/Library/Application Support/AgentInBox/app-config.json`

`AGENT_IN_BOX_CONFIG_DIR` 可覆盖配置目录；`AGENT_IN_BOX_DATA_ROOT` 可强制锁定数据根。环境变量锁定时，首次向导和存储迁移不能修改路径。

## 2. 选择数据根

1. 优先选择非系统盘，避免系统盘空间压力和权限问题。
2. Windows 路径尽量短、使用 ASCII，避免过长的 Unicode 路径；存储页会提示大于 180 字符的路径。
3. 预留空间：Linux 镜像、覆盖盘、快照、任务产物和下载缓存会同时占用空间。
4. 存储页显示 Host Reserve、分类占用、可用空间和低空间警告。

## 3. 迁移数据根

- 迁移在存储锁保护下进行；同一数据根只能有一个迁移/清理操作。
- 逐文件复制并校验 SHA-256；SQLite 使用在线备份并执行 `integrity_check`；可选 `qemu-img check`。
- 全部成功后才原子更新 `app-config.json`；任何失败都保留旧配置和旧目录。
- 迁移成功需要重启本地服务。旧目录**不会自动删除**，确认新目录可用后由用户自行清理。
- 迁移后检查 qcow2 backing file 路径；当前会校验镜像并提示旧路径引用，不会自动重写。
- 迁移是单次 HTTP 请求并持有存储锁，不提供流式进度事件。

## 4. 数据库备份与恢复

### 自动迁移前备份

- 控制平面启动时，如果检测到旧数据库存在待应用 Schema Migration，会先创建 SQLite 在线备份。
- 备份文件：`backups/pre-migration-<时间>-<from>-to-<to>.sqlite`。
- 备份先写 `.partial`，执行 `PRAGMA integrity_check` 后 rename；同时写入 `<file>.sha256`。
- 默认保留 5 份，`AGENT_IN_BOX_MIGRATION_BACKUP_KEEP` 可设置 1～50。
- 备份创建/校验/校验和写入失败会阻止启动，不允许无备份迁移。

### 手动恢复

控制平面停止后：

1. 选择要恢复的 `pre-migration-*.sqlite`，用 `.sha256` 校验文件；
2. 备份当前 `agent-in-box.sqlite`、`-wal`、`-shm`；
3. 将备份复制为 `agent-in-box.sqlite`，删除旧 `-wal`/`-shm`；
4. 启动控制平面；如果备份是旧 Schema，会再次执行迁移前备份和 Migration；
5. 检查项目、任务和 Worker 历史。

恢复会回退到备份时刻的数据；之后产生的任务/消息不会自动合并。不要把恢复共享 VM 快照当作单项目回滚。

## 5. 自动升级备份

- Electron 更新安装前会停止本地服务，备份 SQLite 主库/WAL/SHM 和已安装的 `app.asar`、`app.asar.unpacked`、`control-plane`、`web`。
- 更新成功启动后清除 pending；失败可在设置页回滚。
- 回滚恢复数据库和应用资源并重启应用。Windows 文件锁可能影响替换，需在干净安装环境验证。

## 6. 快照与项目备份

- 整机快照影响所有绑定项目；恢复前会列出受影响项目、活动任务和 Lease，并要求确认。
- 恢复整机快照要求 VM `stopped`、无活动任务和 Lease。
- 项目备份只备份绑定项目的 Guest 工作目录（tar.gz + SHA-256），与整机快照独立。
- Guest 工作目录支持 Linux POSIX 路径和 Windows 盘符绝对路径（如 `C:\Users\aib-worker\workspace`）；Windows 盘符根目录、UNC、NTFS 数据流和 `..` 会被拒绝。
- 恢复项目备份遇到共享目录、绑定变化、VM 停止或活动任务时会阻止；多 VM 绑定恢复不是跨 VM 原子操作。
- 项目备份拒绝符号链接、特殊文件和路径逃逸。

## 7. 清理与空间不足

- “清理下载缓存”只删除 `downloads/` 内容，不触碰镜像、VM、快照、产物、归档或数据库。
- 存储页有可用空间警告；低于阈值时先清理缓存或迁移到更大磁盘。
- 手动删除数据根目录前确认 `.agent-in-box-data-root` 标记；卸载时默认保留数据，只有用户明确选择“删除数据”且目录带有标记才会清理。
- 备份目录会随迁移一起复制，便于升级后仍可回滚；如不需要可手动保留最近几份。

## 8. 故障排查

- `SQLite 完整性` 或 `Schema Migration` 检查失败：停止服务，保留数据库和 `-wal`/`-shm`，从最新迁移前备份恢复。
- 空间不足：检查 `vms/` 覆盖盘、`downloads/` 缓存和 `snapshots/`；不要直接删除正在使用的 qcow2。
- 迁移失败：读取存储页错误和日志；旧目录/旧配置应仍可用，不要手动修改锁文件。
- 更新回滚失败：查看桌面日志和 `backups/`，在干净 Windows 环境复现文件锁问题。
