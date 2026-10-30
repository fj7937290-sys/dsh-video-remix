# 视频创作（dsh-video-remix）

把文案变成**带配音的讲解视频**。一套能力，两种形态。

| 形态 | 位置 | 给谁用 |
|---|---|---|
| **DSH 插件** | 仓库根目录 | DeepSeek Harness：注册 `render_video` / `list_voices` / `voice_samples` |
| **通用 skill** | `skills/video-remix/` | 任何 agent：`analyze` / `render` / `samples` / `voices` 四个 CLI 命令 |

插件本身**不含生成逻辑**，它只是把 skill 暴露成工具 —— 一套实现，两处受益，修 bug 和加音色都只做一遍。

---

## 两种画面

| 模式 | 速度 | 适用 |
|---|---|---|
| **cards**（默认） | 10 段约 1 分钟 | 教程、说明、命令演示 —— 文字一字不差 |
| **ai** | 每段几分钟 | 宣传片、创意短片 —— 真实画面，但慢且要 `AGNES_API_KEY` |

教程类建议 `cards`，因为 AI 生成会把命令和步骤画糊。

---

## DSH 插件用法

```
render_video(
  title="90秒讲清楚这个插件",
  voice={ engine: "edge", name: "zh-CN-YunxiNeural" },
  segments=[
    { title: "视频之眼", sub: "让纯文本 AI 看懂视频", narration: "这个插件能让纯文本的 AI 看懂视频。" },
    ...
  ]
)
```

```
list_voices()      // 看看有哪些声音
voice_samples()    // 为每个音色生成一段同样的话，供人试听挑选
```

---

## skill 用法

```bash
cd skills/video-remix && npm install        # 首次需要装 Edge TTS 依赖

node scripts/remix.mjs voices               # 列音色
node scripts/remix.mjs samples --out 音色试听 # 生成全部音色试听包
node scripts/remix.mjs analyze 参考视频.mp4 --interval 2   # 抽帧 + 转写
node scripts/remix.mjs render script.json   # 渲染
```

`analyze` 产出可读材料（带时间码的拼图 + 逐句台词），文案由模型写，落在 `script.json` 里 —— 每次生成都可检查、可微调。

---

## 音色

**在线（14 个中文，神经语音）** —— 需要联网：

| 音色 | 说明 |
|---|---|
| `zh-CN-YunxiNeural` | ★ 云希，男声，自然百搭（默认） |
| `zh-CN-XiaoyiNeural` | ★ 晓伊，女声，偏年轻 |
| `zh-CN-YunxiaNeural` | ★ 云夏，男声，少年感 |
| `zh-HK-WanLungNeural` | ★ 雲龍，粤语男声 |
| 其余 | 晓晓、云扬、云健、东北小北、陕西小妮、粤语/台湾各音色 |

**本地离线（3 个，Windows）** —— 慧慧（女）、瑶瑶（女）、康康（男）。老式合成，机械感明显，但不联网。

跑 `voice_samples` 会把 17 个音色都用同一段话念一遍，听感比名字可靠。

---

## 依赖

| 依赖 | 说明 |
|---|---|
| Node ≥ 18 | |
| ffmpeg | 探测顺序：`FFMPEG_PATH` → 本 skill `bin/` → 从 skill 与 cwd 向上找 `_tools/...` → PATH |
| `@andresaya/edge-tts` | 在线音色。`skills/video-remix` 下执行 `npm install` 安装（不进 git） |
| Windows | 仅**离线音色**需要；其他平台用在线音色 |
| `AGNES_API_KEY` | 仅 `visual="ai"` 需要 |

---

## 与 dsh-video-eyes 的关系

| | dsh-video-eyes | dsh-video-remix |
|---|---|---|
| 干什么 | **看懂**视频（抽帧、时间码、转写、识图） | **做**视频（配音、卡片、合成） |
| 工具名 | `read_video` / `read_video_transcript` | `render_video` / `list_voices` / `voice_samples` |
| 冲突 | 无 | 无 |

两者互补，可以串联：`read_video` 分析参考片 → 模型写稿 → `render_video` 产出新片。

**都不占用 `vision_` 前缀** —— `dsh-vision-router` 会接管该前缀下的所有工具并在视觉模式关闭时隐藏它们，所以两个插件都刻意避开。
