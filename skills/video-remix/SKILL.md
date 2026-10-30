---
name: video-remix
description: |
  分析一个参考视频，再生成一个新的「配音 + 文字卡片」讲解视频。分析侧抽帧打时间码、拼成总览图并转写台词；生成侧用神经语音合成配音、用 ffmpeg 绘制卡片、混流成 mp4。

  当以下情况时使用此 Skill：
  (1) 用户给一个视频，要求「照着这个风格/结构做一个新视频」
  (2) 用户要把一篇文章、一段说明、一个产品介绍做成 60–180 秒的讲解视频
  (3) 用户要求给视频加配音、做字幕卡片、做教程短片
  (4) 需要先把视频拆解成可复用的结构（分镜 / 文案 / 节奏），再据此产出新内容
whenToUse: 需要「分析参考视频 → 生成新的讲解视频」或「给文字内容配音做成卡片视频」时
metadata: {"video-remix": {"requires": {"ffmpeg": true, "node": ">=18", "os": ["win32", "darwin", "linux"]}, "optionalEnv": ["ITINGNAO_API_KEY", "FFMPEG_PATH"]}}
---
# video-remix

把「看视频」和「做视频」接成一条流水线：**分析参考片 → 写文案 → 配音 → 画卡片 → 合成**。

只需要 Node 18+ 和 ffmpeg。**不注册任何 Harness 工具**，只提供命令行，因此与任何插件都不冲突。

---

## 三个命令

```bash
# 0) 先听音色：为每个可用音色生成一段同样的话，放进一个文件夹
node scripts/remix.mjs samples --out 音色试听

# 1) 分析参考视频：抽帧（带时间码）+ 转写台词
node scripts/remix.mjs analyze demo.mp4 --interval 2

# 2) 渲染新视频：读 script.json，配音 + 画卡片 + 合成
node scripts/remix.mjs render script.json --out my-video.mp4

# 附：只列音色，不出文件
node scripts/remix.mjs voices
```

### 先用 samples 挑音色

`samples` 会用**同一段文本**读遍所有音色，输出到指定目录，并生成一份 `README.md` 清单（音色名、性别、语言、文件名）。听一遍再决定用哪个，比看名字猜靠谱。

文本固定为：

> 你好，这是语音合成试听。本科生想发第一篇 SCI，记住三步：第一，找导师；第二，拆解论文；第三，先复现，再创新。

17 个音色全读这句话，才能公平比较语速和语气。

---

## 工作流

### 第一步：分析

```bash
node scripts/remix.mjs analyze 参考视频.mp4 --interval 2
```

产出 `analysis.json`，里面有三样东西：

| 字段 | 内容 |
|---|---|
| `video` | 时长、分辨率、fps、有无音轨 |
| `sheets[]` | 每页拼图的路径 + 覆盖的时间段（`from`–`to`） |
| `transcript.segments[]` | 逐句台词 + `startSec` |

拼图每格左上角都烧了**真实时间码**，所以第 N 页第 k 格的时间 = `from + k × interval`。

> 这一步不做「理解」，它只负责把视频拆成可读的材料。真正的理解由调用它的模型完成 —— 模型读 `sheets` 的图和 `transcript` 的文字，再写下一步的脚本。

### 第二步：写 script.json

模型根据分析结果写这份脚本：

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

`narration` 是**念出来的台词**，`title` / `sub` 是**画面上的字**。两者可以不同 —— 台词口语化，画面精简。

### 第三步：渲染

```bash
node scripts/remix.mjs render script.json
```

默认输出到 `生成视频/<标题>.mp4`。每段时长由配音实际长度决定（也可以用 `duration` 手动指定）。

---

## 音色

### 在线（推荐，神经语音，接近真人）

★ = 听完整套试听后挑出的首选，日常优先用这四个：

| 音色 | 说明 |
|---|---|
| `zh-CN-YunxiNeural` | ★ 云希，男声，自然百搭（默认推荐） |
| `zh-CN-XiaoyiNeural` | ★ 晓伊，女声，偏年轻 |
| `zh-CN-YunxiaNeural` | ★ 云夏，男声，少年感 |
| `zh-HK-WanLungNeural` | ★ 雲龍，粤语男声 |
| `zh-CN-XiaoxiaoNeural` | 晓晓，女声，最经典自然 |
| `zh-CN-YunyangNeural` | 云扬，男声，新闻播报腔 |
| `zh-CN-YunjianNeural` | 云健，男声，偏浑厚 |
| `zh-CN-liaoning-XiaobeiNeural` | 小北，女声，**东北话** |
| `zh-CN-shaanxi-XiaoniNeural` | 小妮，女声，**陕西话** |
| `zh-HK-HiuGaaiNeural` / `zh-HK-HiuMaanNeural` | 粤语女声 |
| `zh-TW-HsiaoChenNeural` / `zh-TW-HsiaoYuNeural` / `zh-TW-YunJheNeural` | 台湾国语女 / 男 |

需要联网，依赖 `@andresaya/edge-tts`（已装在本 skill 目录）。

### 本地离线（Windows）

```bash
node scripts/remix.mjs render script.json --engine local --voice Kangkang
```

| 音色 | 性别 | 接口 |
|---|---|---|
| Huihui | 女 | WinRT / SAPI |
| Yaoyao | 女 | WinRT |
| Kangkang | 男 | WinRT |

音质是老式拼接合成，机械感明显，但**完全离线**。

> 注意：本地音色走的是 WinRT，不是老的 SAPI 接口。SAPI 只能看到 2 个音色，WinRT 能看到 3 个（含男声）。

---

## 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--interval <秒>` | `2` | analyze 的抽帧间隔，0.1–10 |
| `--out <路径>` | 见下 | analyze 的输出目录 / render 的输出文件 |
| `--no-transcribe` | 关 | analyze 时跳过转写 |
| `--engine edge\|local` | `edge` | 配音引擎 |
| `--voice <音色名>` | `zh-CN-XiaoxiaoNeural` | 见上表 |
| `--api-key <key>` | `$ITINGNAO_API_KEY` | analyze 转写用 |

`script.json` 里还可以设：`width`/`height`（默认 1280×720）、`titleSize`、`subSize`、`watermarkText`、`leadMs`（每段开头留白，默认 400）、`gap`（段尾留白，默认 0.8）、`theme`。

---

## 独立性

- **不注册工具**：只提供 CLI，不占工具名、不改任何插件的状态。
- **不依赖其他 skill**：分析、配音、渲染全在本目录内。
- **不会与 `vision_*` 系列冲突**：完全不碰那个命名空间。
- 与 `video-eyes` skill 的关系：功能有重叠（都能分析视频）。建议**只用其中一个做分析**，否则会重复消耗 ffmpeg 和转写配额。`video-remix` 适合「分析 → 再造」，`video-eyes` 适合「只看不造」。

---

## 局限

1. **画面只有文字卡片** —— 这不是 AI 生成画面。想要真实画面，把 `sheets` 和文案交给 `agnes-video` 之类的生成能力，再回来用 `render` 合成配音。
2. **单段配音建议 ≤ 15 秒** —— 太长会显得呆板，拆成多段更好。
3. **在线音色需要联网** —— 断网时用 `--engine local`。
4. **转写需要听脑 Key** —— 没有 Key 时 `transcript.status` 会写明原因，不影响抽帧。
