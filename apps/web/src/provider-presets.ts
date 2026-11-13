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
    baseUrl: "https://api.deepseek.com/v1",
    api: "openai-completions",
    models: [text("deepseek-chat"), { ...text("deepseek-reasoner"), reasoning: true }],
  },
  {
    id: "qwen",
    label: "通义千问（阿里云 DashScope）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    api: "openai-completions",
    models: [
      text("qwen-plus"),
      text("qwen-turbo"),
      text("qwen-max"),
      vision("qwen-vl-plus"),
      vision("qwen-vl-max"),
    ],
  },
  {
    id: "zhipu",
    label: "智谱 GLM（BigModel）",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    api: "openai-completions",
    models: [
      { ...text("glm-4.5"), reasoning: true },
      text("glm-4-plus"),
      text("glm-4-flash"),
      vision("glm-4v-plus"),
    ],
  },
  {
    id: "moonshot",
    label: "Moonshot Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    api: "openai-completions",
    models: [
      text("kimi-k2-0905-preview", "Kimi K2"),
      text("moonshot-v1-8k"),
      text("moonshot-v1-32k"),
      text("moonshot-v1-128k"),
    ],
  },
];

export const CUSTOM_PRESET_ID = "custom";

export const DEFAULT_PRESET_ID = "deepseek";
