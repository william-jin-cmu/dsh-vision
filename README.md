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
| **默认** | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-plus` | 通义 VL，国内直连，新用户有大额免费额度；难图换 `qwen-vl-max` |
| **零成本** | `https://open.bigmodel.cn/api/paas/v4` | `glm-4v-flash` | 智谱永久免费（30 并发上限），注册即用 |
| **离线** | `http://localhost:11434/v1` | `qwen3-vl:4b` | Ollama 本地，无需 key，中文 OCR 推荐小尺寸 Qwen-VL |
| **未来** | DeepSeek 官方识图 API（官方口径 "soon"） | — | 上线即一行配置切换，现有 DeepSeek key 直接用 |

API key 读取顺序：插件配置 `apiKey` → `$DSH_VISION_API_KEY` → `$DASHSCOPE_API_KEY`。

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
  baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1
  apiKey: ""          # 留空则读环境变量
  model: qwen-vl-plus
  maxTokens: 1024
  timeoutMs: 60000
  maxImageBytes: 10485760
```

## 开发

```sh
./scripts/build.sh                 # 用 dsh 检出的 tsc 编译 src/ → lib/（产物入库）
<dsh-checkout>/node_modules/.bin/vitest run --root .   # 13 个 spec：真实 Cordis 组合 + 注入 fetch
```

设计说明：桥接抽象与 Qwen 官方 [Qwen-MM-Plugins](https://github.com/QwenLM/Qwen-MM-Plugins) 的 `vision_chat` 一致（OpenAI 兼容 `/chat/completions` + `image_url`），但本插件是零依赖 TS、原生 cordis 形态，不引入 Python/uv/MCP。本地图片以 base64 data URL 内联；`exec.signal` 全程透传，取消即中断请求；错误信息自动脱敏 API key。

## License

BSD-3-Clause
