# Pi RPC + Computer Use 验证 Harness

> 目的：在不消耗真实模型额度的情况下，验证 Pi 的事件流、图片回传、CUA 工具循环、Abort 和 Session Resume。脚本化模型不是 LLM，不能据此宣称真实模型任务成功率。

## 文件

- `cua-extension.js`：Pi Extension，注册 `vm_screenshot`、`vm_click`、`vm_type_text`、`vm_keypress`、`vm_wait`，通过 Bearer Token 调用真实 Go Guest Agent。
- `mock-model-server.mjs`：本地 OpenAI-compatible `/v1/chat/completions`，按固定序列返回工具调用；记录是否收到 PNG base64。
- `models.json`：注册 `mock/mock-cua`，支持 text + image 输入。
- `run-rpc-validation.mjs`：Pi JSONL RPC 客户端，校验工具循环、Guest 文件结果、Abort、会话恢复。
- `setup-guest.sh`：在 Guest 用户目录安装固定 Node 24.18.0 和 Pi 1.5.1，不使用 sudo。
- `run-guest-validation.sh`：启动 mock 模型并运行整体验证。

## 运行前提

1. 桌面 VM 已启动，XFCE 已登录，Guest Agent 使用短期测试令牌运行。
2. QEMU 转发 SSH `10023` 和 Guest RPC `17611`。
3. 为输入测试打开并最大化一个 XFCE Terminal；当前 harness 把它作为输入目标，不从截图自动定位。
4. 复制 `pi/` 文件到 `/home/aib/pi-validation`，`models.json` 放到 `/home/aib/.pi/agent/models.json`。
5. 执行 `setup-guest.sh` 一次，然后执行 `run-guest-validation.sh`。

## 验证点

- Pi RPC 选择 `mock/mock-cua` 并建立持久会话；
- `vm_screenshot` 返回的 PNG 在下一次模型请求中实际出现；
- 工具循环依次完成截图、点击、中文输入和回车，Guest 文件内容 SHA256 与预期一致；
- 慢任务在 `vm_wait` 工具执行期间被 Abort，RPC 返回并达到 `agent_settled`；
- 关闭 Pi 后用 `--session <file>` 恢复，消息数不减少；
- 每次请求都暴露全部 CUA 工具。

## 边界

- 这只证明 Pi 的集成机制和工具协议可用；真实模型的 Computer Use 准确率、长任务稳定性和 Thinking 兼容性必须使用真实凭据另测。
- 当前 mock 日志显示 Pi 同时暴露内置 `read/bash/edit/write` 工具。它们运行在 Guest 内，符合“所有直接执行局限于 VM”的边界；Router 不得获得这些工具。
- 若 Guest 出现内核 panic 或 WHPX 异常，记为 `environment_error`，不要计入模型失败。

## 真实模型 + Model Broker

- `model-broker.mjs` 在 WSL 侧读取既有 Pi provider 配置，持有真实上游凭据；Guest 使用 `http://10.0.2.2:6719/v1` 和本地 Broker Token。
- `run-real-rpc-validation.mjs` 使用真实模型执行一个固定 CUA 任务，并校验 Guest 文件和工具调用。
- `run-real-guest-validation.sh` 为 Guest 生成同时包含 mock/broker 的 models.json，运行真实模型验证。
- 2026-11-10：`pro` 模型一次通过，13.37 秒完成截图 → 中文输入 → 回车 → 截图；回读 Guest models.json 确认不含上游 API Key。

Broker 当前是验证原型：只支持 OpenAI-compatible chat completions，监听 WSL 回环，日志不记录内容和密钥。生产版本还需短期令牌签发/撤销、模型白名单、用量记录、超时和错误映射。

