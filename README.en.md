# gtrk-cli (formerly the Tonghe Smart Creation Toolkit)

**English** · [简体中文](README.md)

<!-- Bilingual pair: edits here MUST be mirrored in README.md (section structure is guarded by test/readme-bilingual.test.mjs). -->

> The video-production pipeline CLI for Gitruck Cloud (同合云) — **agents drive cloud jobs, artifacts land locally, and three editing-suite project formats (desktop client / Jianying / Premiere) stay interoperable**.
>
> One command turns a raw talking-head recording into an editable, re-cuttable project. The cloud does the heavy lifting, your machine only assembles, and the source video never leaves it.

**🔗 [Website](https://cloud.ai-mcn.tv/zh-CN/cli) · [Tutorial](https://hocassian.feishu.cn/wiki/HCFpwoF7SivIFbkKosgcFMcEnxk) · [Quick start](https://cloud.ai-mcn.tv/zh-CN/docs/quick-start) · [Desktop client](https://cloud.ai-mcn.tv/zh-CN/download) · [npm](https://www.npmjs.com/package/@gitruck/cli) · [User agreement](https://hocassian.feishu.cn/wiki/T6UywR8b3ik4Mgk7tP9c1b7Kn0b) · [Privacy policy](https://hocassian.feishu.cn/wiki/ZLRNwlEhfishYtkosUhcofMYnPf)**

![Put AI creation capabilities into your local agent](assets/gtrk-agent-intro.png)

---

## Why gtrk-cli

- **One command, three project formats**: upload the raw take → cloud-side smart editing (strips filler, repeats, long pauses) → pull back **desktop client (gtrk) + Jianying + Premiere/FCP** project files → the output folder opens automatically.
- **Cloud does the heavy lifting, your machine only assembles**: recognition, cutting and alignment all happen in the cloud; locally you only receive the result, and **the source video never leaves your machine** (its path is written into the project, so opening it locally resolves the media directly).
- **Built for agents**: ships with the `gtrk-oralcut` skill — inside Claude Code / Codex / Cursor / Gemini CLI / TRAE and friends, "cut this talking-head for me" is enough to kick it off. The CLI is the hands, the agent is the brain.
- **A general-purpose toolbox**: a single binary with parallel subcommands — every `gtrk <xyz>` (oralcut / split / mg / matrix / render …) is a **domain-agnostic driver/tool**; a production flow starts whichever ones it needs and leaves the rest alone, and more drivers can be added later. Modelled on Feishu's (Lark) `lark-cli`. It is currently used for humanities & social-science videos, but nothing in the design is tied to any particular show.

## Features

| | Command | What it does |
|---|---|---|
| 🎬 | `gtrk oralcut <raw>` | Full talking-head editing loop: emits gtrk + Jianying + Premiere projects in one pass and opens the output folder |
| ✂️ | `gtrk long2short <raw>` | Long-to-short loop: semantic segment selection + jump cuts on a long video (optional 720p-proxy smart split-screen) → per-clip gtrk + Jianying + Premiere projects (the raw file is never uploaded). **If you only want a finished cut and will not edit further, use fine-cut** `gtrk tool video_long2short_pro` |
| 📝 | `gtrk transcript <local video>` | Video to transcript: the original video is not uploaded, only locally extracted audio, producing one Markdown file with a summary, timecoded record and plain text |
| 🎵 | `gtrk music-visualizer <audio>` | Music visualization: one song → a spectrum-visualizer video (`--template` required, optional background/cover and template/color styling), with the companion driver skill `gtrk-music-visualizer` |
| ✂️ | `gtrk split [split doc]` | Visual split dispatcher: finished cut × transcript projection → validated beat storyboard (`struct_meta.split` + `dispatch.json`), driving four lanes; `--column <id>` validates against your show's vocabulary |
| ⚙️ | `gtrk init` | Guided one-time setup (API key + Jianying draft folder), then forget about it |
| 🩺 | `gtrk doctor` | Health check: config / cloud connectivity / Jianying folder / runtime in one shot |
| 📦 | `gtrk deps` | Runtime assets: `status` shows where ffmpeg/fonts come from and under which licence, `install` fetches them from the Gitruck Cloud mirror (**must be triggered explicitly — never a silent auto-download**) |
| 🤖 | `gtrk skills install` | Installs the 10 bundled CLI skills into the agents detected on this machine, via the generic `skills` adapter plus a gtrk supplement layer; `--all` covers every registered host |
| ⬆️ | `gtrk upgrade` | Upgrade the CLI to the latest version + refresh skills (config preserved); `--check` only reports |
| 🎞️ | `gtrk render` | Render a gtrk project (EDL) locally → finished mp4 (requires ffmpeg) |
| 🔎 | `gtrk matrix` | B-roll retrieval + **candidate track laying**: consumes the FILM_BROLL dispatch → produces a candidate list + downloads preview proxies and lays N candidate tracks (`--lay N`, default 1; open it in opencut and toggle track visibility to compare; `--lay 0` produces the list only); `matrix search "<query>"` is a one-off ad-hoc search |
| 🎨 | `gtrk mg` | MG motion-graphics particle laying: consumes the MG dispatch → lays html-particle assets (transparent overlay / full-screen bed, produced by your show's MG skill) into the `.gtrk` `beat_track`; `mg lint <particle.html>` runs the statically checkable subset of the house rules, `mg status --project <dir>` is an orchestration dashboard; aux overlay particles can be layered on the same span (one beat derives a main particle plus `-aux<n>`). The old name `gtrk rrv` remains as a deprecated alias |
| 🧰 | `gtrk tool <name>` | Single-shot tool family: image-to-camera-move, image/video matting, image black-border removal / aspect adaptation / cleanup / square conversion / LivePhoto, smart collage covers and vertical stitching (multi-image input), video black-border removal / aspect adaptation / stabilization / vaporwave filter / mechanical & semantic shot segmentation / motion highlights / AI subtitles, vocal-accompaniment separation / speaker diarization / pitch-and-tempo shift, piano-to-MIDI and piano restoration, audio denoising, silence removal, MAD, and more; `gtrk tool list` shows every input/output/live price/status. Single request, single result, shared runner — adding a tool means adding one descriptor |
| 🚧 | `struct` | (planned) convert an existing gtrk project into the three formats |

---

## Getting an API key

The CLI calls Gitruck Cloud capabilities, so you need an API key first (it looks like `gc_xxxxxxxx`):

1. Open **[cloud.ai-mcn.tv](https://cloud.ai-mcn.tv)** and sign in — **signing in activates your account**, free trial credits included, no gatekeeping.
2. Go to the **[console](https://cloud.ai-mcn.tv/zh-CN/dashboard)** and create/copy your key under "API keys / key management".
3. The next step, `gtrk install`, will prompt you to paste it (configure once, reuse locally forever).

> Terms of record: [User agreement for the "OpenCut Gitruck Edition" client and the "gtrk CLI"](https://hocassian.feishu.cn/wiki/T6UywR8b3ik4Mgk7tP9c1b7Kn0b) · [Privacy policy](https://hocassian.feishu.cn/wiki/ZLRNwlEhfishYtkosUhcofMYnPf) — **signing in or completing registration on the website constitutes your acceptance**; when you call cloud capabilities from the CLI, you are the party primarily responsible for the legality of the content you process.
>
> Quick-start docs: [cloud.ai-mcn.tv/zh-CN/docs/quick-start](https://cloud.ai-mcn.tv/zh-CN/docs/quick-start) · Business enquiries: business@migotimes.com

## Install & first run

Requires Node.js ≥ 20.6 (check with `node -v`).

```bash
# 1) 一条命令装全：命令行 gtrk + /gtrk-oralcut skill + 配置（填 API Key、自动扫剪映目录）
npm i -g @gitruck/cli@latest && gtrk install
#   或免全局安装直接用：npx @gitruck/cli@latest install

# 2) 剪一条（剪完自动打开产物目录）
gtrk oralcut "D:/素材/某选题-原始口播.mp4" --script "D:/素材/某选题-文字稿.txt"

# 或把本地视频转成一个 Markdown 文字稿
gtrk transcript "D:/素材/采访视频.mp4"
```

> Only want the config and not the skills? Use `gtrk init`. For local development: `cd gtrk-cli && bun install && bun run src/index.ts <command>`.

The output folder is named `<raw-name>-video-project-<YYMMDD-HHMMSS>/` and contains the `gtrk/`, `jianying/` and `xml/` projects.

> **Re-installing will not re-prompt for config**: `gtrk install` / `gtrk init` detect an existing setup and keep it, refreshing only the skills. Add `--reconfigure` to change things (you can press Enter to keep the existing key or Jianying folder).

## Operating map: from zero to a finished video

> **You just talk; let the agent do the CLI typing.** Below is the end-to-end route — what comes first, what comes next, and what to do when things go sideways.

**One-time setup (once, then forget)**

1. **Install the CLI**: `npm i -g @gitruck/cli@latest && gtrk install` (installs gtrk + skills + your API key in one go).
2. **(Optional) Create a show style**: if you want your own visual grammar and vocabulary, tell your agent "**build the style system for my show**" (`/gtrk-style-maker` interviews you and turns the answers into your own skill family plus a show config). **Skip it and you get the default kitchen** — the end-to-end flow still runs.

**Per video (an ordered SOP with checkpoints — you talk to the agent, and it is not a one-shot parallel fan-out)**

Lanes are laid **in order, with a checkpoint at every step**: lay B-roll first to fix the base layer → you adjust it → then stack MG on top → finally add AI re-enactment. You drive each step by conversation and the agent runs the matching command.

| Step | What you say to the agent | What the agent does | Where you step in |
|:--:|---|---|---|
| ① | "**cut a version** of this talking-head" | `/gtrk-oralcut` → `gtrk oralcut` → three projects + transcript | — |
| ② | "now **split it into a storyboard dispatch**" | `/gtrk-splitter` → `gtrk split` → `dispatch.json` with four lanes | review the dispatch |
| ③ | "**lay the B-roll first**" | `/gtrk-matrix` → `gtrk matrix` → candidate tracks laid | **pick/adjust B-roll in opencut** (toggle track visibility to compare) |
| ④ | "B-roll is settled, **lay the MG**" | `/gtrk-mg` → `gtrk mg` → MG particles stacked on top of the B-roll | fine-tune particles (by hand in opencut) |
| ⑤ | "**add the AI re-enactment**" | `/gtrk-ai-drama` (skill, no command) → four-part description docs (Chinese/English blocks) | generate on an external platform, drop the clips back in by hand |
| ⑥ | "**produce the final cut**" | the desktop client's production chain (multi-lane compositing + cloud particle rendering / export to Jianying); `gtrk render` only produces a **main-track snapshot preview** | final polish inside the client |

> The order exists for a reason: **MG stacks on top of B-roll**, so the B-roll base has to be settled and approved before MG goes on; AI re-enactment comes last. Skip lanes you do not need (an empty queue in `dispatch` simply lays nothing).
>
> ③④⑤⑥ all require **going back to the desktop client** to select, polish, re-insert and produce — the CLI lays material into `.gtrk`, and the client turns `.gtrk` into a finished video. See the "**CLI × desktop client**" section below.

**When things go sideways**

| Situation | What to do (tell the agent, or it handles it) |
|---|---|
| You only want the editing project, no visuals yet | Stop after "cut a version": "just the editing project for now" |
| Lost the report / want the artifacts on another machine | "fetch the previous one by taskId" → `gtrk oralcut-result <taskId>` (skips the cloud re-run) |
| You want to choose between several B-roll candidates | "lay a few more B-roll candidates" → `gtrk matrix --lay N`, then toggle track visibility in opencut |
| B-roll fill is poor / there are empty slots | Adjust `--score-floor` / `--top-k` and re-run, or "search a single query" → `matrix search "<query>"` to patch it |
| Picture / particles need frame-level polish | Open the project in opencut and adjust by hand (what the agent laid is an **editable project**, not a flattened render) |
| Cannot connect / config problems | "run a health check" → `gtrk doctor` (config / cloud / Jianying folder / version in one shot) |
| A new version is out | "upgrade" → `gtrk upgrade` (upgrades the CLI + refreshes skills, config preserved) |

## CLI × desktop client: hands and brain, one `.gtrk` throughout

**The standard workflow is never "CLI only" — it is the CLI and the desktop client working together, and the client is an unavoidable part of producing a finished video.** The division of labour:

- **CLI = headless assembler (hands / mechanical work)**: it deterministically packs cloud editing results, retrieved B-roll and show-produced particles into the project and atomically writes back `.gtrk` (cut the talking-head / split the dispatch / lay B-roll candidate tracks / lay MG particles). It makes no aesthetic judgements and produces no final cut.
- **Desktop client = the workbench with a screen (eyes / polish)**: it opens **the same `.gtrk`** so you can look, choose, polish frame by frame, drop AI clips back in, and produce the final video. Installation is the one-liner in the "Upgrade → desktop client" section (OpenCut Gitruck Edition).

**`.gtrk` is the handover medium between them** — it is Gitruck Cloud's unified project contract (a true superset of a timeline + HTML particles + `struct_meta`), **written by the CLI, read by the client, in both directions**. So a video advances by **alternating** between CLI and client:

```
CLI 写 .gtrk ─▶ 客户端打开(自动感知外部改动、先存脏改再刷新、不丢稿)
   ─▶ 你在客户端挑/调/精修 ─▶ 需要就再喊 agent 让 CLI 写下一轮(铺 MG / 铺 AI…)
   ─▶ … 反复 … ─▶ 客户端出片
```

**These things can only be done in the client (the CLI cannot give them to you):**

| Stage | Why it must happen in the client |
|---|---|
| **Choosing B-roll candidates** | `gtrk matrix` lays N candidate tracks; you toggle each track's visibility to compare, pick one, and delete the rest — an aesthetic call only a person in the client can make |
| **MG / particle polish** | The client renders html-particles as **live transparent previews** with frame-level Transform/Blending/Effects tuning |
| **Talking-head fine cut** | Magnetic main-track ripple editing, manual nudging of cut points / pauses / split-screens |
| **Re-inserting AI re-enactment** | AI clips generated on external platforms are **dragged into the AI_DRAMA lane by hand** and aligned to their spans (`/gtrk-ai-drama` only emits description docs; the footage is produced externally — see SOP ⑤) |
| **Final production** | Multi-lane compositing (overlay / MG / cloud-rendered particles stacked) plus Jianying draft export both live in the client's production chain |

> **`gtrk render` ≠ the final cut.** `gtrk render` is a local ffmpeg **snapshot preview of the main track (the rough talking-head cut)** — it merges only the main video and audio tracks and **does not composite overlays (B-roll candidates) / MG particles / AI re-enactment**. For a **real multi-lane finished video** (all lanes stacked, particles cloud-rendered, Jianying draft exported), use the **client's production chain**. In one line: **the CLI puts material into the project; the client turns the project into a video.**

## Upgrading

**CLI + skills** (config preserved as-is):

```bash
gtrk upgrade          # 有新版则升到最新 + 刷新 skill
gtrk upgrade --check  # 只看有没有新版，不动手
```

> If you use `npx` (no global install), you already get the latest every time: `npx @gitruck/cli@latest install`. `gtrk doctor` will also mention when a newer version exists.

**Desktop client**: re-run the one-line installer to overwrite-install the latest (per-user, no admin rights, config untouched):

```powershell
irm https://api.ai-mcn.tv:9000/broadcast/exe/install.ps1 | iex
```

## Using it with AI agents

Once installed, a single sentence in any agent invokes a gtrk skill:

| | |
|:--:|:--:|
| ![Calling gtrk from an agent, example 1](assets/agent-example-1.png) | ![Calling gtrk from an agent, example 2](assets/agent-example-2.png) |
| ![Calling gtrk from an agent, example 3](assets/agent-example-3.png) | ![Calling gtrk from an agent, example 4](assets/agent-example-4.png) |

`gtrk install` installs the 11 bundled CLI skills (`gtrk-oralcut`·`gtrk-long2short`·`gtrk-splitter`·`gtrk-matrix`·`gtrk-mg`·`gtrk-ai-drama`·`gtrk-style-maker`·`gtrk-transcript`·`gtrk-tools`·`gtrk-music-visualizer`·`gtrk-cover`) into the agents detected on this machine. The mechanism matches lark-cli: gtrk hands its local skill sources to the generic `skills` CLI, which owns agent detection, directory mapping and update rules; gtrk no longer hardcodes per-vendor paths.

By default `~/.agents/skills` is the single source of truth, linked into each agent's compatible directory (junctions on Windows); where linking is unavailable the adapter falls back to copying. That way updates touch one canonical copy instead of letting duplicates drift apart. Common commands:

```bash
# 自动探测已安装的 Agent（等价核心：npx -y skills add <gtrk包根>/skills -g -y）
gtrk skills install

# 只装指定宿主；这里使用通用 skills CLI 的 Agent ID
gtrk skills install --agents codex,cursor,gemini-cli,trae-cn

# 安装到适配器当前支持的全部 Agent（会创建较多宿主目录）
gtrk skills install --all

# 不使用链接，每个宿主各复制一份
gtrk skills install --copy
```

`--agents` accepts agent IDs from both the upstream adapter and the gtrk supplement layer. Chinese agents already covered include `trae`, `trae-cn`, `codebuddy`, `qoder`, `qoder-cn`, `qwen-code`, `kimi-code-cli`, `iflow-cli`, `codearts-agent` and `lingma`, plus `workbuddy`, `qoderwork` and `comate` which upstream has not registered yet. Common shorthands — `qwen`, `kimi`, `iflow`, `codearts`, `tongyi-lingma`, `qoder-work`, `baidu-comate` — are mapped automatically. When upstream adds new agents, gtrk can use the new IDs without a release; if an existing script must hardcode a directory, `--dir <skills dir>` still gives you the compatible copy mode.

**Agent input UIs are not standardized**: Claude usually surfaces skill names in `/` completion; different Codex clients enter via `$`, `/skills` or a Skills panel; TRAE relies mostly on Skills settings, explicit naming or semantic triggering. So not seeing a Claude-style `/gtrk-*` dropdown does not mean the skill is missing. If a new skill does not show up, refresh the window or start a new session.

Then just say "**cut a version of this talking-head**", or explicitly pick `gtrk-oralcut` from your agent's Skills entry point. The agent will ask about the raw file, script and pacing, call `gtrk oralcut --json` to run the loop, verify the artifacts and tell you how to open all three formats. The full portable playbook is in [`AGENT.md`](./AGENT.md).

**Hand the whole chain to the agent**: it is not just the talking-head cut — keep going with "split the storyboard", "lay the B-roll", "lay the MG particles", "render the video", and the agent will pair each show-specific production skill with `gtrk split` / `gtrk matrix` / `gtrk mg` / `gtrk render` to run the entire **production pipeline**. **You just talk; leave the CLI typing to the agent** — the "Command reference" below exists so the agent can look up parameters, not so you type them in a terminal.

### Capabilities agents can drive (skill drives command)

**Each capability = one skill (the brain — you trigger it, it knows its place in the SOP and handles interaction) driving one gtrk command (the hands — deterministic mechanical work).** Production is an **ordered SOP with a user checkpoint at every step**, not a one-shot parallel fan-out — a `/gtrk-X` skill runs `gtrk X` at the right moment, with your confirmation:

| SOP | Driving skill (what you say) | Underlying command (what the agent runs) | What it does |
|:--:|---|---|---|
| ① | `/gtrk-oralcut` | `gtrk oralcut` | Smart talking-head cut → desktop client / Jianying / Premiere projects + transcript |
| ② | `/gtrk-splitter` | `gtrk split` | Storyboard dispatch → `dispatch.json` (A_ROLL/MG/AI_DRAMA/FILM_BROLL, four lanes) |
| ③ | `/gtrk-matrix` | `gtrk matrix` | **Lay B-roll first** as candidate tracks → **you adjust/choose** (toggle visibility in opencut) |
| ④ | `/gtrk-mg` | `gtrk mg` | **Then lay MG particles** (stacked on the approved B-roll) |
| ⑤ | `/gtrk-ai-drama` | (no command, pure authoring) | **AI re-enactment last**: emits four-part description docs (backstory / characters / shots / source text, in Chinese and English blocks) → generate on any external platform and re-insert by hand (the artifact is description text with no mechanical tail, same as `/gtrk-style-maker`: skill only, no command) |
| — | `/gtrk-style-maker` | (no command, builds a show) | A one-time interview that builds your show's style system (skill family + show config, see next section) |
| — | (wrap-up) | `gtrk render` | Render a gtrk project locally → finished mp4 |
| 📝 | `/gtrk-transcript` | `gtrk transcript` | Local video → one Markdown file with an agent-written summary, timecoded record and plain text; **not part of the production SOP** |
| 🧰 | `/gtrk-tools` | `gtrk tool <name>` | The single-shot tool family (image-to-camera-move / image & video matting …) — single request, single result, **not part of the production SOP**, usable standalone at any time |
| 🎵 | `/gtrk-music-visualizer` | `gtrk music-visualizer` | One song → a spectrum-visualizer video (template + optional background/cover + colour styling), **not part of the production SOP**, used standalone for audience acquisition |
| 🖼️ | `/gtrk-cover` | (no command, pure authoring) | The two-stage cover workbench: design diagnosis + text-to-image prompts in three sizes and two languages → you generate images on an external platform → an HTML5 typesetting workbench (drag/scroll fine-tuning, one-click export to multiple PNG sizes). Show-specific cover aesthetics are injected through the show config's `style.skills` (`produces:"cover"`); **not part of the production SOP** (it is the "stage zero" companion to distribution) |

> **Skill vs command**: `/gtrk-mg` is the **brain** — it knows it belongs at SOP step ④ (MG only after B-roll is settled), asks for your confirmation, and resolves which particle type to produce from the show config; `gtrk mg` is the **hands** — purely deterministic lint + track laying. You trigger the skill by talking, and the skill runs the command for you.
> The 10 `/gtrk-X` skills above are **framework skills bundled with the CLI** (installed by `gtrk skills install`) — `/gtrk-transcript` independently drives video-to-transcript, `/gtrk-tools` covers only the single-shot tool family, `/gtrk-cover` handles covers, and none of the three belong to the production SOP; `/gtrk-ai-drama`·`/gtrk-style-maker`·`/gtrk-cover` are pure authoring skills (no command). Show-specific **visual style and content** come instead from your own show's production skills (created by `/gtrk-style-maker`, bound through the show config's `style.skills`) and are never hardcoded into these framework skills.

**How each lane's actual visuals/content get produced** — what the MG looks like, what tone the AI re-enactment has — is not hardcoded into the CLI. It comes from **your own show's production skills** (created interactively with `/gtrk-style-maker`, kept locally). They are bound through the show config's **`style.skills[].produces`** (the value is the lane name), and **general-purpose drivers** such as `gtrk mg` / `gtrk matrix` consume them accordingly. **The direction is: the CLI drives the show skills** — show skills only supply style/content and carry no "which command to run" orchestration; the framework only knows lanes and pipeline interfaces, and the look always belongs to your show. Without a show, the built-in defaults are used and everything still runs end to end.

---

## Shows and style: a two-layer structure

> **The show config is remodelling your kitchen; producing a video is cooking dinner. You do not remodel the kitchen before every dish, but every dish is indeed cooked in the kitchen you remodelled.**

The system has two layers on completely different time scales:

**[Show layer · one-time / infrequent] = building a show (remodelling the kitchen)**
Run `/gtrk-style-maker` (a meta skill). It uses a heuristic interview to help you work out **your own** visual grammar — presupposing no dimensions at all: it does not assume you have a narrative structure, a thematic system, or a split between animation and live action. Your dimensions and their values are entirely yours to define. It produces:

- Your own executable skill family (written into the current agent's user-level skills directory; a black box, kept local)
- A vocabulary shared inside the show (referenced by every skill in the family, preventing drift between multiple definitions)
- The show config `~/.gitruck/columns/<id>.json` (vocabulary + B-roll retrieval preferences + a list of style references)

**[Production layer · every video] = cooking (the shape of the flow never changes)**
Cut the talking-head → split the script → dispatch (B-roll retrieval / motion graphics / re-enactment) → assemble → render. Every step explicitly consumes the current show config: script splitting validates against your vocabulary (`--column <id>` or the config's `defaultColumn`), B-roll retrieval follows your show's retrieval preferences (`broll.column_tag_ids` show tags / `material_class_policy` / facets), and each lane goes through your own production skills.

**No show configured? Use the default "kitchen".** Zero config = the built-in default show; everything runs end to end, byte-for-byte identical to the behaviour before show configs existed — the show layer is an optional asset, not a mandatory gate.

**Pipeline contract**: the framework presupposes nothing about aesthetics and is fully authoritative about pipeline interfaces. Skills whose artifacts enter the render pipeline must satisfy the corresponding contract (see [`contracts/`](./contracts/README.md), e.g. `gsap-emit v1` for HTML animation particles); a contract only constrains machine-decidable pipeline properties, and what the picture looks like is always yours.

---

## Configuration

`gtrk init` writes config to `~/.gitruck/config.json` (a unified user-level directory — config, caches, ffmpeg and show configs all live under `~/.gitruck/`). Resolution order: **environment variables / `.env` > persisted `init` config > default base URL**.

| Item | Source | Notes |
|---|---|---|
| `GITRUCK_API_KEY` | env / init | The **bare value** of the `Authorization` header (not a Bearer token) |
| `GITRUCK_API_BASE` | env / init | API base URL, defaults to `https://api.ai-mcn.tv:10000` |
| Jianying draft folder | init / auto-detect / `--jianying-draft-dir` | Determines where Jianying drafts land and whether they open directly |
| `defaultColumn` | hand-written in config.json | Default show config id (used by `gtrk split` when `--column` is omitted; if that is also missing, the built-in default show) |
| Show config | `~/.gitruck/columns/<id>.json` | One file per show; generated and registered by `/gtrk-style-maker`, or hand-written |

Non-interactive configuration (scripts / CI):

```bash
gtrk init --api-key <KEY> --jianying-draft-dir auto -y
```

Run `gtrk doctor` any time for a self-check:

```
✅ 运行时：node v24.x
✅ CLI 版本：v0.3.0（已是最新）
✅ API Key：已配（gc_xxx…）
✅ 云端连通 + 鉴权：可达，鉴权通过
✅ 剪映草稿目录：C:\Users\…\com.lveditor.draft
```

---

## Command reference

### `gtrk transcript <local video>`

Turns a local video into a multi-level Markdown transcript. It accepts local video paths only: the CLI extracts 16 kHz mono audio on your machine and uploads only that derivative. The original video is never uploaded, and URLs or platform video downloads are not supported.

```bash
gtrk transcript "D:/素材/采访视频.mp4"
gtrk transcript "D:/素材/采访视频.mp4" --lang zh-CN --out "D:/文字稿/采访.md" --json
```

By default it produces only `D:/素材/采访视频-transcript.md`, whose structure is fixed:

1. `## 总结` (Summary): the CLI marks it as pending, and `/gtrk-transcript` drives the agent to read the full text, generate it and write it back;
2. `## 文字记录` (Transcript record): readable paragraphs each starting with `[00:01:23]`;
3. `## 纯文本` (Plain text): the complete recognized text, easy to copy in one go.

Live pricing is queried from the website's price table under `asr` before the run; neither the CLI nor the docs store price numbers. With `--json`, stdout contains only `{ok,taskId,fileId,output,summaryPending}`, where `output` points at that single Markdown file; `summaryPending:true` means `/gtrk-transcript` still needs the agent to write the semantic summary and replace the pending marker in place — the deliverable remains the same single file.

### `gtrk oralcut <raw>`

| Parameter | Purpose | Default |
|---|---|---|
| `-s, --script <file>` | Script txt (cutting against a script is more accurate) | Looks for a `.txt` next to the raw file; otherwise reconstructs the script automatically |
| `-p, --preset <p>` | Pacing `steady`\|`concise`\|`compact` (loose → tight) | `concise` |
| `-o, --out <dir>` | Custom output folder | `<raw-name>-video-project-<timestamp>` |
| `-f, --formats <list>` | Comma-separated list of the three formats | `gtrk,jianying,xml` |
| `--jianying-draft-dir <dir>` | Jianying draft root (or `auto`) | Reads the init config / auto-detects |
| `--reupload` | Force re-upload, ignoring the upload cache | off |
| `--no-open` | Do not open the output folder when done | **opens automatically by default** |
| `--json` | Machine-readable: stdout carries only the result JSON (for agents / scripts) | off |

`--json` output (a single stdout line on success): `{ ok, outDir, files:{gtrk,jianying,xml}, jianyingDraftPath, rendered, report, errors, taskId, fileId }`; on failure the process exits non-zero, errors go to stderr, and stdout carries no JSON.

> Every run **always writes a `result.json` into the output folder** (regardless of `--json`), and once submission succeeds it also drops a `task.json` breadcrumb. Even if stdout is lost or the run crashes midway, the report and `taskId` are on disk, and `oralcut-result` below can fetch everything back in seconds without re-running the cloud job.

### `gtrk oralcut-result <taskId>`

Fetches the report and the three project formats of an **already completed** task by `task_id` (with optional local rendering), **skipping preprocessing / upload / submission / polling** — use it when the report is lost or you want to pull the artifacts again on another machine, without re-running the cloud job.

| Parameter | Purpose | Default |
|---|---|---|
| `-o, --out <dir>` | Output folder | `<cwd>/<taskId>-video-project-<timestamp>` |
| `--render` | Additionally render locally (requires the raw file still at the path embedded in gtrk, plus ffmpeg) | off |
| `--jianying-draft-dir <dir>` | Jianying draft root (or `auto`) | Reads the init config / auto-detects |
| `--no-open` / `--json` | Same as `oralcut` | — |

> Fetching results requires the **same account's** API key that submitted the task (a different account or a deleted task returns `TASK_NOT_FOUND`). The report is stored with the task record and stays available long-term; the underlying artifact files are cleaned up after roughly **60 days**, after which the report is still retrievable but artifact downloads 404 (the command tells you and still writes the report to disk).

### `gtrk split [split doc]` — visual split dispatcher

Finished cut × transcript projection → beat storyboard. **No positional argument = export the projection view** (projects the current `.gtrk` timeline × transcript into a beat view for splitting/proofreading, without writing back); **with a split doc = validate and land it** (validates the doc's machine contract → projects beat timecodes → atomically writes back `struct_meta.split` and produces the `split/dispatch.json` dispatch list, driving the A_ROLL / MG / AI_DRAMA / FILM_BROLL lanes). Timecodes always belong to the CLI (a split doc only describes "which span does what" and never carries timecodes).

| Parameter | Purpose | Default |
|---|---|---|
| `--project <dir>` | The oralcut output folder (locates `gtrk/project.gtrk` and `transcript/transcript.json` automatically) | — |
| `--gtrk <path>` / `--transcript <path>` | Explicit project / transcript paths (fallback for non-standard layouts) | Derived from `--project` |
| `--column <id>` | Show config id (validates lane / category / produces against your show's vocabulary) | config `defaultColumn` → built-in default show |
| `--md` | Also render the human-readable `split/visual-split.md` when landing (rendered one-way from the JSON) | off |
| `--words` | Attach word-level detail in view mode | sentence level only |
| `--json` | Machine-readable: stdout carries only the result JSON | off |

> The landed `dispatch.json` has three queues feeding downstream consumers: `mg` (MG particles) → the `gtrk mg` command, `film_broll` → the `gtrk matrix` command, `ai_drama` → the `/gtrk-ai-drama` skill (which emits four-part description docs in Chinese/English blocks; pure authoring, no command). The companion skill `/gtrk-splitter` produces the split doc.
>
> **Dispatch entries carry their own `span:{from,to}`** (the utterance range that entry covers; `overlay` aux entries carry **their own** span, which may be a sub-range of the main beat's). **`track_st/track_ed` are a snapshot taken at projection time** — `gtrk mg` / `gtrk matrix` **re-project on the spot** when consuming them (see below), so after editing the talking-head track you do **not** need to re-run `gtrk split`; only a change to the split doc itself requires that.

### `gtrk matrix` — B-roll retrieval + candidate track laying

**No positional argument = consume the dispatch**: reads the `film_broll` queue from `split/dispatch.json` → dual-endpoint retrieval → produces the candidate list `split/broll-plan.json`, downloads preview proxies, and lays N candidate tracks in the project (open it in opencut and toggle track visibility to compare and choose). **`matrix search "<query>"` = a one-off ad-hoc search** (independent of any dispatch).

| Parameter | Purpose | Default |
|---|---|---|
| `--project <dir>` | The oralcut output folder (locates `split/dispatch.json` and the artifact destination) | — |
| `--dispatch <path>` | Explicit `dispatch.json` path | Derived from `--project` |
| `--column <id>` | Show config id (uses your show's B-roll retrieval preferences: tags / material_class / facets) | config `defaultColumn` → built-in default show |
| `--lay <n>` | How many candidate tracks to lay (`0` = produce the plan only, lay nothing) | `1` |
| `--top-k <n>` | Candidate cap per query (overrides the dispatch's shots; server cap is 50) | dispatch value |
| `--material-class <c>` | Material type `real_shot` \| `concept` (matrix-member endpoint only; overrides the show policy) | show policy |
| `--score-floor <f>` | Fill-confidence floor: segments scoring below this are not used and the slot stays empty — empty spots **expose the black bed track** (laid by default; only `--no-black-bed` exposes the main track instead). Raising it shrinks the candidate pool, and a span that cannot be filled at all becomes pure black over the talking-head, so check the hole warnings after adjusting | `0.2` |
| `--no-black-bed` | Do not lay the solid black bed track (one is laid by default) | laid by default |
| `--force-relay` | Strip and re-lay even when you have already edited a candidate track in the client (by default it refuses and keeps that track) — **this deletes the `broll-raw-*` material registrations of confirmed source clips, orphaning those files on disk** | off |
| `--out <file>` | Write ad-hoc results to a file | stdout |
| `--json` | Machine-readable: stdout carries only the result JSON | off |

> **Beat windows are re-projected on the spot**: in dispatch-consumption mode, **before the first cloud retrieval**, each beat's `[track_st, track_ed]` is recomputed from "`transcript` × the current `.gtrk`", and retrieval, `broll-plan.json` and track laying all use the recomputed values (`--lay 0` obeys the same rule; ad-hoc `search` is unaffected). The timecodes in `dispatch.json` are only a **projection-time snapshot**, used as a fallback solely when re-projection is impossible — **so after editing the talking-head track you can run this command directly without re-running `gtrk split`**. `--json` always emits `reprojection:{mode,degraded,reason?,drifted,max_offset,shrunk,dropped}`; beats with **zero surviving span** after re-projection are skipped (no retrieval quota is burned on them and nothing is laid). If re-projection is impossible (missing transcript / project not found / no talking-head material on the main track) → it **degrades to the snapshot with a warning and a `--json` marker**, while retrieval and the plan still complete instead of hard-failing; behaviour for non-v1 projects is unchanged (the plan lands first, then the version gate exits non-zero).
>
> Candidates' `preview_url`/`cover_url` **are unsigned and never expire** (once the local proxy is on disk it is always reused); what carries a signature and expires in roughly 24 h is the **source `url`**, re-signed by the client's "confirm source clip" flow — **you do not need to re-run this command just to re-sign**.
>
> **Re-running strips and re-lays, but never touches tracks you edited**: candidate tracks are identified by "material prefix + last round's registration fingerprint", no longer by track number (saving in the client renumbers all overlay tracks). Once a candidate track is judged "edited by you" (a clip was changed, or you confirmed the source clip in the client so the material became `broll-raw-*`), this run **lays nothing at all**: no track is stripped, no track is appended, `.gtrk` is byte-for-byte unchanged, `broll-plan.json` is still produced, and the command reports "which track / what evidence / what to do next" and exits non-zero (`--json` emits `{ok:false, refused:[…]}`). Add `--force-relay` to force a re-lay.
>
> **Material-on-disk self-check**: after writing back the project it verifies that every `materials[].path` really is on disk (**read-only, reports without touching anything**). Relative paths are always resolved against the **directory containing the `.gtrk` file** (`<output>/gtrk/`). `--json` emits `integrity:{ checked, counts, dangling:[…], danglingReferenced, danglingOrphan, external:[…], noPathIds:[…] }` — `dangling` is the complete list of **broken references** among project-owned materials (registered but missing on disk), each flagged with **whether the timeline references it** and where (a referenced one means that span has no media to show, far worse than an orphan); missing absolute paths are counted separately as `external` (an unmounted external drive looks like this too, so it does not pollute the main verdict); http(s) materials are only counted and **no network requests are made**. **This informs, it does not block**: broken references do not change `ok`, do not change the exit code, and no material entry or file is deleted. They are usually historical residue (e.g. an interrupted "confirm source clip" download); the fix is to re-confirm the source clip in the client or delete that clip. Runs that never wrote back (`--lay 0` / refused / missing project) **emit no `integrity` field** — absence means "not checked this time", not "checked and clean".
>
> **The solid black bed track**: by default a solid black track is laid beneath all candidate tracks and above the talking-head main track (`struct_meta.broll.black_track` records its `track_index`), covering the full landed beat envelope so that during B-roll (including the empty spots on candidate tracks) the talking-head picture underneath is not exposed. **The cost is "black holes"**: wherever candidate tracks are not filled, pure black covers the talking-head, and track laying computes exactly that — `--json` always emits `lay.blackBedHoleSec` plus per-span `lay.blackBedHoles`, and a non-fatal warning is added when a single span is ≥ 3 s or a single beat's ratio is ≥ 15 % (it does not change the exit code or block laying). Use it to adjust `--score-floor`, switch to `--no-black-bed`, or patch by hand in the client. The bytes land at `assets/builtin/solid-000000-<W>x<H>.png`, sharing an id namespace with the client's built-in solid material and reused idempotently. Do not delete it by accident when removing candidate tracks; to swap footage, drag onto a candidate track's clip and **not onto the black bed** — since client 0.2.10 (force-updated release on 2026-07-31) **dropping onto the black bed is rejected outright with a message**. On clients older than 0.2.10 (force update not yet pulled) the old behaviour silently creates a new video track and inserts there; if it lands in the lower half you cannot see it in the preview at all (one `Ctrl+Z` undoes the whole thing) — restart the client first to pick up the force update. If you do not want the black bed, re-run with `--no-black-bed` and it is stripped clean.

### `gtrk mg` — MG motion-graphics particles (lay / lint / status)

Consumes the `dispatch.mg` dispatch landed by `gtrk split`, laying html-particle assets produced by **your show's MG skill** into the `.gtrk` project's `beat_track`. Three modes are dispatched by the first positional word: **no argument = lay**, `mg lint <file>` = single-file validation, `mg status` = orchestration dashboard. The old name `gtrk rrv` remains a deprecated alias (it prints a notice; prefer `gtrk mg`).

| Parameter | Purpose | Default |
|---|---|---|
| `--project <dir>` | The oralcut / split output folder (locates `split/dispatch.json` and the `.gtrk` project) | — |
| `--dispatch <path>` | Explicit `dispatch.json` path (fallback for non-standard layouts) | Derived from `--project` |
| `--only <beat>` | Run a single beat only (takes a **beat id** such as `B12`, not a `composition_id`; the main particle and its `-aux<n>` overlays are selected together). **True incremental merge**: only the matched particles are re-laid, and every other already-laid particle on the track (including your manual tweaks) is preserved as is | all |
| `--lint-only` | Lint only; lay nothing and write nothing back | off |
| `--replace-all` | Explicitly authorize a **full track reset**: no incremental preservation, the whole track is stripped and re-laid — **this deletes every other already-laid particle on the track** | off |
| `--json` | Machine-readable: human logs go to stderr, stdout carries only the result JSON | off |

- **Laying** (`gtrk mg --project <dir>`): reads `dispatch.mg` → for each beat takes the source particle from `<project>/mg/<composition_id>.html` → lints → lays it into `beat_track` and atomically writes `struct_meta.mg` back into `.gtrk` (self-produced tracks are registered idempotently in `lay_tracks`; a re-lay strips the previous self-produced items before appending, and user-added tracks are never touched). Whether a particle is a "transparent overlay" or a "full-screen bed" is decided by `opaque`, inferred from the particle HTML's root `background`. Beats with a missing HTML file or a failed lint are counted in `skipped` and do not block the rest.
  - **The stripping surface ≠ "what gets laid this run", and ≠ "every registered track"**: `--only <beat>` **strips only the matched particles** (true incremental merge) — every other already-laid particle's clip / material / registration entry is **preserved as is**, together with any manual tweaks you made in opencut (what is preserved is the existing clip itself, not a rebuild from the registration, so transparency `opaque` is not lost); those preserved entries are **not re-linted and their source HTML is not re-copied** (the project is self-contained, so deleting files under `<project>/mg/` does not matter). A full re-lay is still "strip clean, then rebuild the whole track", with **one exception**: particles that are in this dispatch but failed to land (missing HTML / failed lint / zero surviving span after re-projection) keep their previous round's clip on the track (a broken new one must not destroy the working old one); conversely, already-laid entries **no longer present in the dispatch** are still stripped (a plan change ≠ something broke). To strip every other already-laid particle too, authorize it explicitly with `--replace-all`.
  - **The material table does not accumulate**: materials are stripped by "**self-produced identity × zero references**" (self-produced = a `mg-`/`rrv-` prefix **or** living under the CLI-exclusive `assets/mg/` with a filename in the self-produced registry), and **it deliberately does not trust the client-rewritable `html_material` prefix** — so re-laying after editing the project in opencut still strips old materials, the `mg-` material count **always equals the number of particles on the track**, and historical duplicate/orphan entries are cleaned up along the way. **Non-self-produced materials are never touched** (`broll-*` / `ex-solid-*` / anything you added, even with zero references); self-produced materials still referenced by a surviving clip are also not stripped (it will never strip a clip into a broken reference); the html copies under `assets/mg/` on disk are never deleted.
  - **"Nothing matched" is not a clear-everything instruction**: when `--only` matches nothing, `dispatch.mg` is empty/missing, or every entry in this run was skipped, **while the track already has laid particles**, the write-back is refused (that is a signal that the dispatch or the selector is broken). Add `--replace-all` if you really mean to clear it. A first-time lay (no existing laid entries on the track) is exempt and completes normally, reporting `laid=0`.
  - **Slot windows are re-projected on the spot**: before laying and linting, each queue entry's `[track_st, track_ed]` is recomputed from "`transcript` × the current `.gtrk`", and thereafter the lint slot envelope (house rule ⑦) and the laid clip duration both follow the recomputed values (`--only` obeys the same rule; aux particles re-project against **their own** span and are not conflated with the main beat window). The timecodes in `dispatch.mg` are only a **projection-time snapshot**, used as a fallback solely when re-projection is impossible — **after editing the talking-head track you can lay directly without re-running `gtrk split`**. `--json` always emits `reprojection:{mode,degraded,reason?,drifted,max_offset,shrunk,dropped}` (including under `--lint-only`). Entries with **zero surviving span** after re-projection are skipped and counted in `skipped` (no HTML is copied and nothing is laid back from the snapshot); if re-projection is impossible (missing transcript / project not found / no talking-head material on the main track) → it degrades to the snapshot with a warning and a `--json` marker, and the exit code is unchanged; behaviour for **non-v1** projects is unchanged (the laying path's version gate exits non-zero, while `--lint-only` still produces its report). A successful lay appends this run's timecode provenance (`timecode_source` / `reprojected_at`) into `struct_meta.mg`.
- **lint** (`gtrk mg lint <particle.html> [--dispatch <path>]`): a purely local static check of the machine-decidable subset of the house rules for a particle HTML (wrapped in `<template>`, `data-composition-id` + 1920×1080, `gsap.timeline({ paused: true })`, registration in `window.__timelines`, no `Math.random` / `Date.now`, self-contained with no relative external links, root `background` consistent with `opaque`, …); when `--dispatch` is given it also checks that the `composition_id` matches the dispatch. Any fatal item exits non-zero and reports every reason.
  - **Expected-id consistency** (`1-cid-expect`, **fatal**): the `data-composition-id` inside the HTML must equal the expected id (when laying, the dispatch entry's `composition_id`; for `mg lint`, the filename — but only when it matches the dispatch or looks like `…-B<digits>[-aux<n>]`, so a renamed copy such as `./tmp.html` is not compared). This guards against "copying `<id>.html`, renaming the file and forgetting the id inside" — laying would write a clip/material named after the file while the file registers a different `__timelines` key and fights the same-named particle over the same style scope.
  - **House rule ⑦, timeline length estimation** (`7-fill-slot` / `7-no-estimate` / `7-infinite-repeat`, **always non-fatal, never blocks laying**): when the slot envelope is known (per particle when laying; for `mg lint --dispatch` when it matches a dispatch entry) it computes a **static lower bound** on the GSAP timeline — degrading call by call, counting whatever it can parse (`duration×(repeat+1) + repeatDelay×repeat`, with `yoyo` adding no time), while calls with expression positions or non-literal durations are **skipped and not counted** (ignoring some calls still yields a valid lower bound). Estimate < envelope → warning; nothing computable at all → an explicit notice that "length could not be estimated statically, house rule ⑦ was not verified, and it must be accepted against the real engine's seek" (**never silent**: "could not compute" and "computed and passed" are distinguishable in the output); containing `repeat:-1` → a warning that "an infinite loop makes the total length Infinity, so house rule ⑦ cannot be verified statically; please use a finite repeat computed from the slot". The real criterion is always the render engine frame by frame; this item is only a reminder layer.
  - **House rule ⑧, repeated-primitive merging** (`8-primitive-merge`, **always non-fatal, never blocks laying**): identifies mergeable batches of `line` / `rect` / `path` / `polyline` / `polygon` that are "created inside a loop, or by a named factory called in a loop; landing under the same parent node; and not driven by per-element animation". Only batches whose purely numeric loop trip counts sum to **≥ 8** under the same parent are reported; when bounds involve `.length` or named constants and cannot be computed it still reports "count unknown" without constant folding; elements with per-element `gsap.set` / tweens, or used as a tween's first argument, are excluded. This item only points out "there is a batch of repeated primitives here that can be merged **losslessly**, pixel-identical after merging" — it is **not a risk verdict**: a hit does not mean the particle will reproduce a defect, and a miss does not mean it is safe. The real criterion remains sampling frames from a real render.
  - **Callback and seek semantics** (`x-callback-driven` / `x-engine-api-override` / `x-raf-interval`, **always non-fatal, never blocks laying**): aligned with the same-named section of the contract (added 2026-07-26). GSAP `seek(t)` suppresses callbacks by default → tweened properties still interpolate, but DOM writes inside `onUpdate` do not run, and the failure mode is **the picture freezing at its initial state rather than going black**. The contract places the guarantee on the **engine side** (fixing a frame MUST use `seek(t,false)` / `time(t)` / `progress(p)`), so a particle **driving its picture from callbacks is a compliant style**; these three lint items are merely **sentinels**: `x-callback-driven` = callbacks write the DOM with no seek fallback anywhere (it stays silent when a fallback exists, to avoid nagging); `x-engine-api-override` = the particle overrides `tl.seek` at runtime or replaces `__timelines[…]` with a wrapper object (which would override the engine's explicit `seek(t,true)` and stops working the moment the engine switches to `time()`/`progress()`; a transitional state); `x-raf-interval` = it contains `requestAnimationFrame(` / `setInterval(` (its own clock is not driven by seek, i.e. frozen). All three MUST NOT be fatal — "driving the picture from callbacks" is not a violation.
- **status** (`gtrk mg status --project <dir>`): summarizes the MG pipeline — total beats in `dispatch.mg` / how many source HTML files exist / how many are laid into `.gtrk`, annotating each beat (missing HTML / produced but not laid / laid).

`--json` output: `{ ok, mode:"lay"|"lint"|"status", … }` (each mode carries its own fields, e.g. `laid` / `skipped` when laying, per-beat status for `status`). Laying mode additionally carries **`track_total`** (how many laid particles currently exist on the track), **`kept`** / **`kept_ids`** (how many are **left over from the previous round** and not re-laid this time, plus their `composition_id` list) and **`removed`** (how many old self-produced particles were stripped this run) — `laid` (this run), `track_total` (total on the track) and `kept` (left over) **must be read together**, and `track_total = laid + kept` always holds. Reading `laid` alone makes "lay 1, strip 20" look identical to "patch in 1", and reading only the first two hides the cost that "a few particles on the track are not from this round" (`kept_ids` and `skipped` overlap: something that failed to land this round is still there from the previous one). When not fully green it also carries a machine-readable **`reason`**: `skipped` (some were not laid) / `empty_queue` (**write-back refused**, the project was not modified, with `refused:true` and `blocked[]`) / `no_project` (project missing, nothing laid). Runs that actually wrote back also carry **`integrity`** (the material-on-disk self-check, identical in name and shape to `gtrk matrix`; see the previous section).

> **Exit codes**: an `ok:false` from laying or `--lint-only` **always comes with a non-zero exit** (including the ordinary mid-loop case of "some beats were skipped"). Agents should not read non-zero as "the command crashed" — judge by `reason` / `skipped`.

> **Aux overlay particles**: if `gtrk split` dispatched an `overlay` particle in some beat's `aux_layers`, it derives a `<beat>-aux<n>` composition entry into `dispatch.mg` — `gtrk mg` lays it too, giving you "a main visual on the base track plus a transparent conceptual diagram stacked on the same span".
> **Dual-read compatibility**: `dispatch.mg` (also reads the old `rrv_mg`), the source directory `mg/` (also reads the old `rrv/`), the material prefix `mg-` (also reads the old `rrv-`) — projects created before the de-branding need zero migration.

### `gtrk tool <name> [inputs...]` — the single-shot tool family

Standalone single-request capabilities, kept separate from the pipeline's lane commands (`oralcut`/`split`/`matrix`/`mg`). **A top-level command dispatched by the first positional word** (no parent/child commands): `gtrk tool <name> [inputs...]` runs a tool (multi-file image tools accept several paths, and the order is the assembly order), `gtrk tool list` lists them all. One tool = one thin descriptor (input category / payload assembly / artifact mapping / billing / availability gate), sharing a runner that performs "validate → upload (fingerprint cache, auto-chunked ≥ 256 MiB) → submit → poll → stream-download to disk → `task.json`/`result.json` breadcrumbs" — adding a tool means adding one descriptor, never writing orchestration.

| Tool | Input | Output | Billing | Status |
|---|---|---|---|---|
| `image_move` | One image | Camera-move video (geometry derived from the source orientation: landscape 1920×1080 / portrait 1080×1920) | Queried live before the run | Live |
| `image_matting` | One image | Transparent-background png (`--param` can request a backing plate) | Queried live before the run | Live |
| `image_blackborder_remove` | One local image | Image with black borders removed | Queried live before the run | Live |
| `image_canvas_adapt` | One local image; optional target width/height and `normal` / `rectangle` / `square` | Aspect-adapted image | Queried live before the run | Live |
| `image_purify` | One local image (only material you have the rights to process) | Image cleaned of watermarks, logos or overlays | Queried live before the run | Live |
| `video_matting` | One video (**≤ 10 minutes**, uploaded as-is with no proxy) | Transparent-background webm | Queried live before the run | Live |
| `video_blackborder_remove` | One local video | Video with black borders removed | Queried live before the run | Live |
| `video_canvas_adapt` | One local video; optional target width/height, clip range, canvas mode and audio-free output | Aspect-adapted video | Queried live before the run | Live |
| `video_stabilizer` | One local video; optional `fast` / `exp` / `turbo` | Stabilized video | Queried live before the run | Live |
| `video_vaporwave` | One local video; the filter takes an exact preset name | Vaporwave-filtered video | Queried live before the run | Live |
| `video_purify` | One local video; optional `full_screen` / `subtitle` / `custom`, `ffmpeg` / `raft` and a normalized ROI (only material you have the rights to modify) | One cleaned video | Queried live before the run | Live |
| `video_upscale` | One local video (**≤ 1 minute**); optional `2` / `3` / `4`× and `Reality` / `Anime` | One upscaled video | Queried live before the run | Live |
| `video_interpolate` | One local video; optional `2` / `3` / `4`×, with no extra one-minute limit | One frame-interpolated video | Queried live before the run | Live |
| `video_segment` | One local video; optional `--detector content\|adaptive`, `--threshold` | Shot-range structure in `result-output.json` (structured data, not a downloadable file) | Queried live before the run | Live |
| `video_ai_segment` | One local video; optional `--segment-mode scene\|shot_type\|narrative\|subject` | Semantic shot structure in `result-output.json` (structured data, not a downloadable file) | Queried live before the run | Live |
| `video_motion_cut` | One local video | Camera-move / highlight segment structure in `result-output.json` (structured data, not a downloadable file) | Queried live before the run | Live |
| `video_speaker_detect` | One local video; optional `--language`/`--max-faces-per-frame`/`--detect-body`/`--track-sample-fps` (GPU heavy) | Visible-speaker structure in `result-output.json` (the time base follows the server output) | Queried live before the run | Live |
| `video_face_track` | One local video; optional `--sample-fps`/`--max-faces`/`--min-face-ratio`/`--enable-body-match`/`--similarity-threshold`; `time_ranges` goes through `--params-json` (GPU heavy) | Person id / time span / trajectory structure in `result-output.json` (the time base follows the server output) | Queried live before the run | Live |
| `audio_tts_clone` | **No file**: one of `--text`/`--text-file` (≤ 2000 characters) plus a required `--speaker`; optional language/format/speed/segmentation | Voice-over audio wav/mp3 (billed in minutes derived from the character count) | Queried live before the run | Live |
| `video_ai_subtitle` | One video or audio file; `--language <code>` required; optional `--translate-language`, `--need-render`, `--need-pure`, `--subtitle-type`, `--subtitle-color`. By default only locally extracted audio is uploaded (the raw file never leaves your machine) | `.ass` subtitles + optional burned-in / subtitle-stripped `.mp4` + `result-output.json` (summary + word-level timeline) | Queried live before the run | Live |
| `video_long2short_pro` | One long video (uploaded whole); `--language <code>` required; optional `--output-language`, `--main-topic`, `--output-size`, `--no-jump-cut`, `--duration-pref`, `--max-clip-sec`, `--split-screen`, `--split-orientation`, `--speed-factor`, `--no-camera-move`, `--no-subtitle`, `--subtitle-translate-language` | Finished clips `clip{i}.mp4` + the human-readable report `clips.md` (including polish-degradation details) + `result-output.json` | Queried live before the run | Live |
| `audio_separation` | One audio file; optional `--mode fast\|turbo` | Vocal and accompaniment audio (one or two items, depending on what is returned) | Queried live before the run | Live |
| `audio_speaker_split` | One audio file; optional `--only-struct` | Per-speaker `.wav` stems + a `spoken_list` timeline (`result-output.json`) | Queried live before the run | Live |
| `audio_stretch` | One audio file; optional `--semitones <n>`, `--speed <n>` (> 0) | Pitch/tempo-shifted audio | Queried live before the run | Live |
| `audio_noise_reduce` | One audio or video file; optional `--prop-decrease 0..1` | Denoised audio | Queried live before the run | Live |
| `audio_silence_remove` | One audio file; optional silence threshold and retained length | Silence-trimmed audio | Queried live before the run | Live |
| `piano_audio_to_midi` | One audio file | A MIDI file `.mid` | Queried live before the run | Live |
| `piano_audio_enhance` | One audio file | High-quality WAV + accompanying MIDI (two artifacts) | Queried live before the run | Live |
| `image_to_square` | One image; optional `--max-line <px>` (≤ 20000) | Square image | Queried live before the run | Live |
| `image_to_live` | One image | Subtly animated LivePhoto video `.mp4` (the artifact is a video) | Queried live before the run | Not available (the upstream generation capability is temporarily unavailable; it will be re-listed once restored) |
| `image_classic_template` | **Several images** + a required `--main-title`; optional subtitle/mode/ratio/quality/count/layout | Finished cover/collage (text/pic/render groups, possibly several images) | Queried live before the run | Live |
| `image_vertical_stitch` | **Several images** (order = top-to-bottom stitching order) | One vertically stitched long image | Queried live before the run | Live |
| `video_split_screen` | **2–16 video segments** (multiple positionals); the precise tier uses `--clips-json` (entries `{input:0-based index, begin_time_ms, end_time_ms, crop}`, millisecond time base); nine optional layout/aspect/audio parameters | One split-screen video (its length matches the shortest segment) | Queried live before the run | Live |
| `mad` | One material folder (3–10 videos) + optional `--bgm` | An AE master-composition project `.jsx` (AE only) | Only `--bgm` triggers a live price query | Live |

> Prices come from `gtrk tool list --json` and the anonymous live query printed to stderr before execution; this README stores no price snapshot. `video_matting` probes duration with ffprobe before uploading and rejects anything over 10 minutes outright (nothing is uploaded or submitted — trim it first).
> `mad` is the family's first **local-type "purely local tool with optional cloud extras"**: it runs without a key and triggers no billed job (technique data is delivered through a cloud manifest and cached in `~/.gitruck/mad-cache`, so **the first fetch needs the network and afterwards it runs offline**); only `--bgm` beat-syncing needs a key and triggers one cloud beat analysis. Three degradation tiers (key + beat sync / no key or bad BGM → fixed tempo / cloud failure → degraded) never crash. It produces only `.jsx` and supports AE only.

The seven shared video tools — black-border removal, aspect adaptation, stabilization, vaporwave, cleanup, upscaling and interpolation — accept only the server's current `video_ext`: `.mp4`, `.avi`, `.mpg`, `.mov`, `.flv`, `.mxf`, `.mpeg`, `.ogg`, `.3gp`, `.wmv`, `.h264`, `.m4v`, `.ts`; `.mkv` and `.webm` are rejected locally. Inputs must be local file paths — the CLI does not download remote videos.

- `gtrk tool list [--json]` — list every tool (name/description/input/output/live price/status); `--json` emits a single-line machine-readable array (including dynamic `billingHint`/`pricing`). **Works without an API key**; prices are queried anonymously through a public endpoint, and on failure the full list is still shown with an unavailable marker.
- `gtrk tool image_move ./photo.jpg [--json]` — image to camera move; artifacts land in `photo-image_move/`. `--param width=1080 --param height=1920` overrides the derived geometry.
- `gtrk tool image_matting ./portrait.jpg` / `gtrk tool video_matting ./clip.mp4` — image/video matting.
- `gtrk tool image_blackborder_remove ./photo.jpg [--json]` — automatically crops black borders from one image.
- `gtrk tool image_canvas_adapt ./photo.jpg --canvas-width 1080 --canvas-height 1920 --canvas-type rectangle [--json]` — image aspect conversion; omitting the canvas parameters uses the server defaults. Per the actual runtime contract the canvas mode accepts only `normal`, `rectangle` and `square`, not the `fit` from older docs.
- `gtrk tool image_purify ./photo.jpg [--json]` — clean watermarks, logos or overlays from an image you have the rights to process.
- `gtrk tool video_blackborder_remove ./clip.mp4 [--json]` — automatically crops black borders from one video while keeping the original audio.
- `gtrk tool video_canvas_adapt ./clip.mp4 --canvas-width 1080 --canvas-height 1920 --canvas-type rectangle --clip-start 12 --clip-end 60 --without-audio [--json]` — video aspect conversion; `--clip-start/--clip-end` are start/end frame numbers, omitted fields use the server defaults, and the canvas mode accepts only `normal`, `rectangle`, `square`.
- `gtrk tool video_stabilizer ./clip.mp4 --stabilizer-method turbo [--json]` — video stabilization; supports `fast`, `exp` and `turbo`, where `exp` is experimental and you should check the result yourself.
- `gtrk tool video_vaporwave ./clip.mp4 --vaporwave-filter "灼熱苦夏" [--json]` — add a vaporwave filter using an exact preset name; omitting it explicitly uses `愈漸升溫`.
- `gtrk tool video_purify ./clip.mp4 --purify-scope custom --purify-method ffmpeg --purify-roi 0,0.78,1,0.2 [--json]` — clean a video you have the rights to modify; the ROI is a normalized `x,y,w,h` and is only used together with `custom`. `raft` supports videos under 20 minutes, `ffmpeg` has no such limit; restoring occluded content is not promised.
- `gtrk tool video_upscale ./clip.mp4 --upscale-times 3 --upscale-type Anime [--json]` — experimental video upscaling; input up to 60 seconds, neither side may exceed 4000 px after scaling, supports `2`, `3`, `4`× and `Reality`, `Anime`.
- `gtrk tool video_interpolate ./clip.mp4 --interpolate-multiplier 3 [--json]` — frame interpolation; supports `2`, `3`, `4`×, does not apply the one-minute limit from older docs, and neither side of the source may exceed 4000 px.
- `gtrk tool video_segment ./clip.mp4 [--detector adaptive] [--threshold 27] [--json]` — mechanical shot segmentation; produces **structured** `result-output.json` (`scene_list` with each range's start/end/duration), not a downloadable file.
- `gtrk tool video_ai_segment ./clip.mp4 [--segment-mode shot_type] [--json]` — semantic shot segmentation; produces `result-output.json` (`categories[].shots[]` with shot size, tags, descriptions and second-level timecodes).
- `gtrk tool video_motion_cut ./clip.mp4 [--json]` — camera-move / highlight segments; produces `result-output.json` (`cut_points[]` with frame numbers, second-level timecodes and motion features).
- `gtrk tool video_ai_subtitle ./clip.mp4 --language zh [--translate-language en] [--need-render] [--subtitle-color 湖蓝]` — AI subtitles: `--language` is required, and it produces `.ass` subtitles + `result-output.json` (LLM summary + word-level timeline). **By default only locally extracted audio is uploaded** (the raw file never leaves your machine, and the geometry is sent along with the request); `--need-render` switches to **burning in locally with ffmpeg** (it errors out if `思源黑体 CN Bold` (Source Han Sans CN Bold) is missing rather than substituting another font); `--need-pure` needs the picture, so adding it uploads the whole video. The `subtitle_type`/`subtitle_color` enums and `content` are documented in the cloud API docs, and `--params-json '{"content":{...}}'` passes them through.
- `gtrk tool video_long2short_pro ./talk.mp4 --language zh-CN [--split-screen] [--speed-factor 1.1]` — long-to-short **fine cut**: finished clips in one shot, one `clip{i}.mp4` each plus the human-readable report `clips.md` (including polish-degradation details). **Division of labour with `gtrk long2short` (rough cut)**: the rough cut produces editable projects (gtrk/Jianying/Premiere), never uploads the raw file, and hands the result to a human for further editing; the fine cut produces only finished videos, uploads the whole file, and costs roughly twice as much. The deciding question: will you edit it afterwards? If yes, rough cut; if no, fine cut.
- The three above are **analysis-type tools**: their artifact is structured data in `result-output.json` (not downloadable media), so `result.json`'s `resultFile` points at it while `files` is empty and `ok=true` — that is normal.
- `gtrk tool audio_separation ./song.mp3 [--mode turbo]` — vocal/accompaniment separation; low-frequency fields such as `--param need_vocals=false` can still be passed through.
- `gtrk tool audio_speaker_split ./meeting.mp3 [--only-struct]` — speaker diarization: by default it produces per-speaker `.wav` files + `result-output.json` (the `spoken_list` timeline); `--only-struct` emits the structure without cutting files.
- `gtrk tool audio_stretch ./song.mp3 [--semitones -3] [--speed 1.5]` — pitch and tempo shifting; pitch and speed are independent, and `--speed` must be > 0.
- `gtrk tool audio_noise_reduce ./interview.mp4 [--prop-decrease 0.5]` — accepts audio or video and always outputs denoised audio.
- `gtrk tool audio_silence_remove ./talk.mp3 [--min-silence-len 800] [--desired-silence-len 200]` — removes over-long silences and writes only the processed audio.
- `gtrk tool piano_audio_to_midi ./piano.mp3` — transcribe piano audio into `.mid`.
- `gtrk tool piano_audio_enhance ./piano.mp3` — piano recording restoration, producing a high-quality WAV as the main artifact plus a companion MIDI.
- `gtrk tool image_to_square ./long.jpg [--max-line 8000]` — long image to square; `--max-line` defaults to 4000 and caps at 20000.
- `gtrk tool image_to_live ./photo.jpg` — turn a still image into a subtly animated LivePhoto; the artifact is an `.mp4` video. (Temporarily unavailable: it will be re-listed once the upstream generation capability is restored.)
- `gtrk tool image_classic_template a.jpg b.jpg c.jpg --main-title "新品速览"` — title + several images into a cover/collage; `--output-pic-count`/`--output-text-count` are clamped to ≤ 20 by the server.
- `gtrk tool image_vertical_stitch top.png mid.png bottom.png` — stitch several images vertically in the order given.
- `gtrk tool video_split_screen a.mp4 b.mp4 --output-ratio 16:9` — simple tier: automatic split-screen layout over the whole clips (reaction / side-by-side comparison).
- `gtrk tool video_split_screen a.mp4 b.mp4 --clips-json '[{"input":0,"begin_time_ms":0,"end_time_ms":5000},{"input":1,"crop":{"x":0.1,"y":0,"width":0.8,"height":1}}]'` — precise tier: specify each segment's millisecond range and normalized crop box by 0-based index; the same file can appear several times to fill several windows.
- `gtrk tool video_speaker_detect ./talk.mp4 --language zh-CN` — detect who is speaking and when on screen, emitting structured JSON (GPU heavy).
- `gtrk tool video_face_track ./talk.mp4 --params-json '{"time_ranges":[{"begin_time":0,"end_time":30000}]}'` — face tracking / identity clustering, optionally limited to time ranges (**in milliseconds**; GPU heavy).
- `gtrk tool audio_tts_clone --text "欢迎收听本期节目" --speaker narrator` — text to voice-over audio (the voice list is in the website docs).
- `gtrk tool audio_tts_clone --text-file 稿子.txt --speaker sweet_female --output-format mp3` — long-form synthesis; by default it follows the speed and segmentation tuned for the chosen voice.
- `gtrk tool mad ./素材 [--bgm 歌.mp3] [--duration 20] [--seed 42] [--refresh] [--json]` — one-click MAD: scan the material folder → auto-select techniques → a single `.jsx` (run it once in AE 2020+ to get the master-composition project). `--seed` makes it reproducible; `result.json` records the seed, data version, degradation tier and chosen techniques.
- Common flags: `--out <dir>` overrides the output folder, `--param k=v` (repeatable) / `--params-json '<object>'` pass cloud parameters through, `--reupload` ignores the upload cache, `--json` is machine-readable, `--ffmpeg-path <dir>` points at an ffmpeg directory.
- Cloud-type tools without a key → an error pointing you at `gtrk init`. A failed artifact download (e.g. an expired link 404) → `result.json` records `errors` with `ok=false`, and `task.json` is kept so you can recover by `taskId`.
- Cleanup, upscaling and interpolation are long-running GPU jobs, and their descriptors poll for up to 4 hours. A wait timeout does not mean the job was cancelled; keep `task.json` / `result.json` and recover by `taskId` instead of re-running and paying twice.

The companion skill is `/gtrk-tools` (one skill covering the whole tool family).

### Other

- `gtrk install [--api-key … -y --skill-agents codex,cursor --all-agents --copy-skills --skills-dir …]` — install everything in one command (skills + config + health check), modelled on Feishu's `lark-cli install`.
- `gtrk init [--api-key … --api-base … --jianying-draft-dir … -y]` — configuration only (interactive or not).
- `gtrk doctor` — health check (including the CLI version and whether a newer one exists).
- `gtrk deps status` — show **where** ffmpeg/ffprobe and the render fonts currently come from (`--ffmpeg-path` / `~/.gitruck` / system / missing), plus version, licence and source-code location.
- `gtrk deps install [--ffmpeg] [--font] [--force]` — install runtime assets from the Gitruck Cloud mirror, **skipping anything already present**.
  - **It never downloads silently**: any missing-dependency path only errors out and points at this command (the packages are 30–90 MB and the distributed artifacts carry licence obligations, so a user or agent must trigger it explicitly).
  - Downloads are always https with **strict sha256 verification**; anything that fails verification is discarded and never lands. Extraction uses the **system tar** (bundled with Windows 10+/macOS/Linux), pulling in no third-party decompression dependency.
  - The resolution order is unchanged: `--ffmpeg-path` → `~/.gitruck/ffmpeg` → system `PATH`. The mirror only fills the middle slot and **never overrides an ffmpeg you installed yourself**.
  - Fonts land in `~/.gitruck/fonts` and are supplied to burn-in through the ffmpeg `ass` filter's `fontsdir` — **never installed into the system font table, never written to the registry, never requiring administrator rights**.
  - The distributed ffmpeg is a GPLv3 build, and the corresponding source is provided alongside the binaries (see `SOURCE.md` at the distribution point); **downloads carry no additional usage restrictions**.
- `gtrk upgrade [--check]` — upgrade the CLI to the latest version + refresh skills (config preserved); `--check` only reports.
- `gtrk skills install [--agents codex,workbuddy,comate,…] [--all] [--copy] [--dir <skills dir>]` — install/refresh agent skills on their own; by default the generic adapter and the gtrk supplement layer detect hosts automatically.

---

## How it works

```
本地 gtrk CLI                          同合云                         本地三端
─────────────                      ─────────────                  ─────────────
毛片 ──上传(指纹缓存免重传)──▶  video_oral_cut 智能剪辑  ──产物──▶  客户端 gtrk/project.gtrk
                                  (一次出 gtrk/剪映/xml)            剪映  自动落草稿目录
源路径写进 gtrk materials.path                                     PR/FCP  导入 premiere.xml
```

- **gtrk** is a true superset of a timeline plus HTML particles, and it is Gitruck Cloud's unified project contract; all three formats derive from the same gtrk file, so their cut points agree.
- The cloud side needs **zero changes** and uses the existing `video_oral_cut`; the CLI only orchestrates (upload / submit / poll / fetch / place / open).

## Notes

- Jianying / CapCut drafts require `draft_content.json` + `draft_meta_info.json` **as a pair** (and they must use exactly those **two filenames** — prefixed variants are not detected) before the app recognizes them. So either configure the draft folder with `gtrk init` or point at it with `--jianying-draft-dir`; otherwise only the content file is produced and you have to import it by hand. The CLI normalizes the filenames when copying into the draft root (`long2short` does the same per clip), while the output folder keeps the clip-prefixed archival names.
- When drive letters differ across machines, config lives under `~/.gitruck/` (user level; the old `~/.gtrk-cli` migrates automatically on first launch), and artifacts default to the raw file's folder.
- Pacing preset strength is decided by the cloud; `--preset` only picks a preset and does not change source trimming.

---

## Layout

```
gtrk-cli/
├── src/index.ts              # commander 入口
├── src/commands/             # 子命令：install / init / oralcut / transcript / split / doctor / upgrade / skills
├── src/lib/                  # cloud / column-config / splitdoc / projection / user-config / jianying / …
├── skills/                   # 打包的框架 skills：oralcut / splitter / matrix / mg / ai-drama / style-maker / transcript / tools / music-visualizer / cover
├── contracts/                # 框架契约库正本（gsap-emit v1 + handoff→契约映射表）
├── assets/                   # README 配图（介绍图 / Agent 调用示例 / 剪映草稿目录指引图）
└── AGENT.md                  # 可移植 agent playbook（skill 底座）
```

A new command = write `register<Name>(program)` in `src/commands/<name>.ts` and register one line in `src/index.ts`.
