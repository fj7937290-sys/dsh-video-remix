# video-remix

把「看视频」和「做视频」接成一条流水线。

```
参考视频 ──analyze──> 拼图 + 台词 ──模型写稿──> script.json ──render──> 新视频
```

只依赖 **Node 18+** 和 **ffmpeg**。不注册任何 Harness 工具，只提供命令行。

---

## 快速开始

```bash
# 看有哪些音色
node scripts/remix.mjs voices

# 分析参考视频（抽帧 + 转写）
node scripts/remix.mjs analyze demo.mp4 --interval 2

# 渲染新视频
node scripts/remix.mjs render script.json
```

---

## 为什么分成两步

分析不产生结论，只产生**可读的材料**。

`analyze` 交出的是：

- 若干张拼图（每格烧了真实时间码）
- 逐句台词（带 `startSec`）

「这些画面说明了什么、该怎么做一条新视频」是模型的活，所以中间隔着一份手写的 `script.json`。这样每次生成都是可检查、可微调的，而不是一次性黑箱。

---

## script.json

```json
{
  "title": "90 秒讲清楚这个插件",
  "voice": { "engine": "edge", "name": "zh-CN-XiaoxiaoNeural" },
  "theme": { "bg": "0x0B1220", "accent": "0x4DA3FF" },
  "segments": [
    {
      "title": "视频之眼",
      "sub": "让纯文本 AI 看懂视频",
      "narration": "这个插件，能让纯文本的 AI 真正看懂视频。"
    }
  ]
}
```

- `narration` 是念出来的口语台词
- `title` / `sub` 是画面上的字
- 两者可以不同：口语要顺，画面要短

可选：`width`、`height`、`titleSize`、`subSize`、`watermarkText`、`leadMs`、`gap`、`duration`（每段）。

---

## 音色

### 在线（神经语音，推荐）

`zh-CN-XiaoxiaoNeural`（晓晓）、`zh-CN-YunxiNeural`（云希）、`zh-CN-YunyangNeural`（云扬）、`zh-CN-YunjianNeural`（云健）、`zh-CN-XiaoyiNeural`（晓伊）、`zh-CN-liaoning-XiaobeiNeural`（东北小北）、粤语、台湾国语等，共 14 个中文音色。

需要联网，依赖 `@andresaya/edge-tts`（已随本 skill 安装）。

### 本地离线（Windows）

`Huihui`（女）、`Yaoyao`（女）、`Kangkang`（男）。

```bash
node scripts/remix.mjs render script.json --engine local --voice Kangkang
```

走 WinRT 接口 —— 老的 SAPI 只能看到 2 个音色，WinRT 能看到 3 个。

---

## 独立性说明

| 关系 | 结论 |
|---|---|
| 是否注册工具 | **否**，纯 CLI，不占工具名 |
| 是否改别的插件状态 | **否** |
| 是否用 `vision_` 命名空间 | **否** |
| 与 `video-eyes` skill | 功能重叠（都能分析视频）。建议只用其中一个做分析，否则重复消耗 ffmpeg 和转写配额 |
| 与 `agnes-video` | 互补：它出 AI 画面，本 skill 出文字卡片并配音，可串联 |
| 跨平台 | 分析/渲染在任何平台都能跑；**本地离线音色仅 Windows**，其他平台用在线音色 |

---

## 局限

1. **画面是文字卡片**，不是 AI 生成的实景。要真实画面请用 `agnes-video`，再用本 skill 的 `render` 配音合成。
2. 单段配音建议 ≤ 15 秒，太长会显得呆。
3. 在线音色需要联网。
4. `analyze` 的转写需要 `ITINGNAO_API_KEY`；没有 Key 时抽帧照常，转写会标注原因。
