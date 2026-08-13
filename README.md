# dsh-vision

给纯文本的 DeepSeek 加上眼睛。Vision for text-only DeepSeek.

deepseek-v4 看不了图。本插件注册一个 `view_image` 工具：模型带着问题调用它（OCR、数数、读图表、看 UI 布局……任意视觉问题），插件把图片和问题转发给任意 **OpenAI 兼容的 VLM 端点**，答案以文本返回。装上之后，dsh 的所有入口（web、TUI、远程通道）同时获得视觉。

```
用户: 看下 ~/Desktop/error.png 是什么报错
模型 → view_image(source="/Users/me/Desktop/error.png", question="这个报错的完整文本是什么？")
     ← "TypeError: Cannot read properties of undefined (reading 'map') at …"
模型: 这是一个 … 建议 …
```

## 真实效果（dsh web，DeepSeek-V4-Flash）

对纯文本的 deepseek-v4 说"看看 images.jpeg 在我的桌面上的"——模型自己定位文件、带着问题调 `view_image`（14.5s），拿到的描述精确到樱花图案、摄像头开孔和底部的 BURGA 品牌标识：

| 桌面上的 `images.jpeg` | dsh web 里的完整过程 |
|:---:|:---|
| <img src="assets/demo-input.jpeg" width="220" alt="测试图片：BURGA 樱花手机壳"> | <img src="assets/demo-session.png" width="640" alt="dsh web 会话：模型自主调用 view_image 并准确描述图片"> |

## 后端选择

一套配置（`baseURL` + `apiKey` + `model`）覆盖所有后端：

| 场景               | baseURL                                                         | model                          | 说明                                                                                                            |
| ------------------ | --------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| **默认（免费）**   | `https://open.bigmodel.cn/api/paas/v4`                          | `glm-4.6v-flash`               | 智谱当前免费视觉模型：128K 上下文、视觉推理，注册拿 key 即用，零成本开箱                                        |
| **付费性价比**     | 同上                                                            | `glm-4.6v`                     | ¥1/¥3 每百万 token，同端点一行升级                                                                              |
| **DashScope 用户** | `https://dashscope.aliyuncs.com/compatible-mode/v1`             | `qwen3-vl-flash`               | 百炼最便宜的 VL 线，高精度 OCR；截图/GUI 重度场景换 `qwen3.7-plus`（ScreenSpot Pro 79.0），难图上 `qwen3.8-max` |
| **火山豆包**       | `https://ark.cn-beijing.volces.com/api/v3`                      | `doubao-seed-2-1-turbo-260628` | 注意 Ark 的模型 ID 带日期后缀（`doubao-seed-2.0-lite` 这种短名会 404），可用列表见 `GET /api/v3/models`         |
| **离线**           | `http://localhost:11434/v1`                                     | `qwen3-vl:4b`                  | Ollama 本地，无需 key                                                                                           |
| **未来**           | DeepSeek 官方识图 API（截至 2026-08 尚未开放，官方口径 "soon"） | —                              | 上线即一行配置切换，现有 DeepSeek key 直接用                                                                    |

API key 读取顺序：插件配置 `apiKey` → `$VISION_API_KEY` → `$DSH_VISION_API_KEY`（仅限 export，dsh 0812 起 `.env` 文件内禁止 `DSH_` 前缀变量）→ `$ZHIPUAI_API_KEY` → `$DASHSCOPE_API_KEY`。推荐写进 `~/.dsh/.env` 的名字是 `VISION_API_KEY`。本地端点（localhost）无需 key。

**免费档降级链**：智谱免费模型偶发限流（429，公共容量池）。默认配置下插件会自动依次降级 `glm-4.6v-flash` → `glm-4.1v-thinking-flash` → `glm-4v-flash`，保证零配置也总能出答案；自定义 `fallbackModels` 可覆盖。thinking 系模型混进正文的 `<think>` 推理块会被自动剥离。

## 实测（2026-08-05，4K 屏幕截图问答，全链路真实调用）

| 模型                               | 结果                               | 延迟      | 备注                                             |
| ---------------------------------- | ---------------------------------- | --------- | ------------------------------------------------ |
| `qwen3-vl-flash`                   | ✅ 准确                            | **~2.9s** | 全场最快，百炼最便宜 VL 线——追求速度选它         |
| `qwen3-vl-plus`                    | ✅ 准确                            | ~3.4s     |                                                  |
| `glm-4.6v-flash`（**默认，免费**） | ✅ 准确                            | ~6.8s     | 高峰限流时自动走降级链                           |
| `glm-4v-flash`（降级兜底）         | ✅ 可用，细节较少                  | ~5.1s     |                                                  |
| `glm-4.6v`                         | ✅ 准确                            | ~10.9s    | ¥1/¥3                                            |
| `doubao-seed-2-1-turbo-260628`     | ✅ 细节丰富                        | ~10-13s   | Ark 模型需控制台开通，ID 带日期后缀              |
| `doubao-seed-2-0-lite-260428`      | ✅ 准确                            | ~14s      |                                                  |
| `qwen3.8-max`                      | ✅ 细节最丰富（认出了 Arc 浏览器） | ~18s      | 旗舰档                                           |
| `qwen3.7-plus`                     | ✅ 准确                            | ~21s      | 推理型，截图/GUI 重度场景                        |
| `kimi-k3`                          | ✅ 准确（也认出了 Arc）            | ~21s      | 推理型，需 maxTokens ≥2048，高峰频繁 429，$3/$15 |

要点：推理型模型（qwen3.7-plus / kimi-k3 / glm-4.1v-thinking）正文前的 `<think>` 块会被自动剥离，且这类模型建议 `maxTokens: 2048` 以上，否则推理会吃光 token 预算。

## 安装

**原生挂载（默认）**——dsh 主程序自带 `~/.dsh/config.yaml` 个人覆盖层，三步完成，不依赖任何第三方管理器：

```sh
# 1) 取码（放哪都行）
git clone https://github.com/dsh-external/dsh-vision ~/dsh-plugins/dsh-vision
# 2) 链接宿主依赖（pnpm 布局下必需，背景见 marisa#2）
CHECKOUT="$(cd "$(dirname "$(readlink -f "$(command -v dsh)")")/../../.." && pwd)"
mkdir -p ~/dsh-plugins/dsh-vision/node_modules/@deepseek-ai
ln -sfn "$CHECKOUT/packages/core/tools"  ~/dsh-plugins/dsh-vision/node_modules/@deepseek-ai/dsh-tools
ln -sfn "$CHECKOUT/vendor/schemastery"   ~/dsh-plugins/dsh-vision/node_modules/schemastery
# 3) 挂载并重启 dsh
cat >> ~/.dsh/config.yaml <<EOF
- insert:
    - id: dsh-vision
      name: '$HOME/dsh-plugins/dsh-vision/lib/index.js'
EOF
```

用 [DSH Companion](https://github.com/dsh-external/dsh-companion) 的话零安装——已随应用自带。

<details>
<summary>可选：经插件管理器安装（Marisa / plugin-registry）</summary>

```sh
dshx install dsh-vision https://github.com/dsh-external/dsh-vision && dshx verify dsh-vision
```

或 `dsh registry install ./dsh-vision && dsh registry enable dsh-vision`。注意 [marisa#2](https://github.com/dsh-external/marisa/issues/2) 修复前，装完仍需按上面第 2 步手工链接宿主依赖。

</details>

## 配置

```yaml
dsh-vision:
  baseURL: https://open.bigmodel.cn/api/paas/v4
  apiKey: "" # 留空则读环境变量
  model: glm-4.6v-flash
  maxTokens: 2048
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
