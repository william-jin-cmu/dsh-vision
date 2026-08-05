# dsh-vision

给纯文本的 DeepSeek 加上眼睛。Vision for text-only DeepSeek.

deepseek-v4 看不了图。本插件注册一个 `view_image` 工具：模型带着问题调用它（OCR、数数、读图表、看 UI 布局……任意视觉问题），插件把图片和问题转发给任意 **OpenAI 兼容的 VLM 端点**，答案以文本返回。装上之后，dsh 的所有入口（web、TUI、远程通道）同时获得视觉。

```
用户: 看下 ~/Desktop/error.png 是什么报错
模型 → view_image(source="/Users/me/Desktop/error.png", question="这个报错的完整文本是什么？")
     ← "TypeError: Cannot read properties of undefined (reading 'map') at …"
模型: 这是一个 … 建议 …
```

## 后端选择

一套配置（`baseURL` + `apiKey` + `model`）覆盖所有后端：

| 场景 | baseURL | model | 说明 |
|---|---|---|---|
| **默认（免费）** | `https://open.bigmodel.cn/api/paas/v4` | `glm-4.6v-flash` | 智谱当前免费视觉模型：128K 上下文、视觉推理，注册拿 key 即用，零成本开箱 |
| **付费性价比** | 同上 | `glm-4.6v` | ¥1/¥3 每百万 token，同端点一行升级 |
| **DashScope 用户** | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3-vl-flash` | 百炼最便宜的 VL 线，高精度 OCR；截图/GUI 重度场景换 `qwen3.7-plus`（ScreenSpot Pro 79.0），难图上 `qwen3.8-max` |
| **火山豆包** | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seed-2-1-turbo-260628` | 注意 Ark 的模型 ID 带日期后缀（`doubao-seed-2.0-lite` 这种短名会 404），可用列表见 `GET /api/v3/models` |
| **离线** | `http://localhost:11434/v1` | `qwen3-vl:4b` | Ollama 本地，无需 key |
| **未来** | DeepSeek 官方识图 API（截至 2026-08 尚未开放，官方口径 "soon"） | — | 上线即一行配置切换，现有 DeepSeek key 直接用 |

API key 读取顺序：插件配置 `apiKey` → `$DSH_VISION_API_KEY` → `$ZHIPUAI_API_KEY` → `$DASHSCOPE_API_KEY`。本地端点（localhost）无需 key。

**免费档降级链**：智谱免费模型偶发限流（429，公共容量池）。默认配置下插件会自动依次降级 `glm-4.6v-flash` → `glm-4.1v-thinking-flash` → `glm-4v-flash`，保证零配置也总能出答案；自定义 `fallbackModels` 可覆盖。thinking 系模型混进正文的 `<think>` 推理块会被自动剥离。

## 实测（2026-08-05，4K 屏幕截图问答）

| 模型 | 结果 | 延迟 |
|---|---|---|
| `glm-4.6v-flash`（免费） | ✅ 描述准确 | ~6.8s（高峰限流时自动走降级链） |
| `glm-4.6v` | ✅ 描述准确 | ~10.9s |
| `glm-4v-flash`（降级兜底） | ✅ 可用，细节较少 | ~5.1s |
| `doubao-seed-2-0-lite-260428` | ✅ 描述准确 | ~11.7s |
| `doubao-seed-2-1-turbo-260628` | ✅ 细节最丰富 | ~19.3s |

## 安装

Marisa（推荐）：

```sh
dshx install dsh-vision https://github.com/dsh-external/dsh-vision
dshx verify dsh-vision
```

或 plugin-registry：`dsh plugin install ./dsh-vision && dsh plugin enable dsh-vision`。

## 配置

```yaml
dsh-vision:
  baseURL: https://open.bigmodel.cn/api/paas/v4
  apiKey: ""          # 留空则读环境变量
  model: glm-4.6v-flash
  maxTokens: 1024
  timeoutMs: 60000
  maxImageBytes: 10485760
```

## 开发

```sh
./scripts/build.sh                 # 用 dsh 检出的 tsc 编译 src/ → lib/（产物入库）
<dsh-checkout>/node_modules/.bin/vitest run --root .   # 17 个 spec：真实 Cordis 组合 + 注入 fetch
```

设计说明：桥接抽象与 Qwen 官方 [Qwen-MM-Plugins](https://github.com/QwenLM/Qwen-MM-Plugins) 的 `vision_chat` 一致（OpenAI 兼容 `/chat/completions` + `image_url`），但本插件是零依赖 TS、原生 cordis 形态，不引入 Python/uv/MCP。本地图片以 base64 data URL 内联；`exec.signal` 全程透传，取消即中断请求；错误信息自动脱敏 API key。

## License

BSD-3-Clause
