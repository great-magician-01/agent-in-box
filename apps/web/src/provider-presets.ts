import type { ModelDefinition, WorkerModelApi } from "@agent-in-box/protocol";

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  api: WorkerModelApi;
  models: ModelDefinition[];
}

function text(id: string, name?: string): ModelDefinition {
  return { id, ...(name ? { name } : {}), input: ["text"] };
}

function vision(id: string, name?: string): ModelDefinition {
  return { id, ...(name ? { name } : {}), input: ["text", "image"] };
}

/**
 * Built-in presets for mainstream domestic model providers. Selecting a preset
 * only fills the form — every field stays editable, and saved providers are
 * ordinary custom providers that can be changed or deleted freely. Both the
 * Anthropic Messages and OpenAI Completions wire protocols stay available via
 * "fully custom".
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    // Official Models & Pricing, verified 2026-11-14:
    // https://api-docs.deepseek.com/quick_start/pricing
    baseUrl: "https://api.deepseek.com",
    api: "openai-completions",
    models: [
      { ...vision("deepseek-flash", "DeepSeek V4.1 Flash"), reasoning: true },
      { ...text("deepseek-v4-pro", "DeepSeek V4 Pro"), reasoning: true },
    ],
  },
  {
    id: "qwen",
    label: "通义千问（阿里云百炼）",
    // The workspace-specific endpoint is recommended by the official OpenAI
    // compatibility guide. The legacy dashscope.aliyuncs.com endpoint remains
    // available, but new presets ask for the user's own WorkspaceId.
    // https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope
    // Current model choices: https://help.aliyun.com/zh/model-studio/getting-started/models
    baseUrl: "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    api: "openai-completions",
    models: [
      { ...vision("qwen4-max-preview", "Qwen4 Max Preview"), reasoning: true },
      vision("qwen3.7-plus", "Qwen3.7 Plus"),
      text("qwen3.8-flash", "Qwen3.8 Flash"),
      vision("qwen3.8-omni-flash", "Qwen3.8 Omni Flash"),
    ],
  },
  {
    id: "zhipu",
    label: "智谱 GLM（BigModel）",
    // https://docs.bigmodel.cn/cn/guide/start/model-overview
    // https://docs.bigmodel.cn/cn/guide/start/quick-start
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    api: "openai-completions",
    models: [
      { ...text("glm-5.3", "GLM-5.3"), reasoning: true },
      { ...vision("glm-5.3-flash", "GLM-5.3 Flash"), reasoning: true },
      { ...vision("glm-5.3-flashx", "GLM-5.3 FlashX"), reasoning: true },
    ],
  },
  {
    id: "moonshot",
    label: "Moonshot Kimi",
    // Current model list (the old K2 and moonshot-v1 IDs are retired):
    // https://platform.moonshot.cn/docs/models
    baseUrl: "https://api.moonshot.cn/v1",
    api: "openai-completions",
    models: [
      { ...vision("kimi-k3.1-pro", "Kimi K3.1 Pro"), reasoning: true },
      { ...vision("kimi-k3.1-pro-highspeed", "Kimi K3.1 Pro 高速版"), reasoning: true },
      { ...vision("kimi-k3", "Kimi K3"), reasoning: true },
    ],
  },
];

export const CUSTOM_PRESET_ID = "custom";

export const DEFAULT_PRESET_ID = "deepseek";
