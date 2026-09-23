# Agent, configuration and command reference

[Back to README](../README.en.md) · [Workflow](workflow.en.md) · [简体中文](reference.md)

## Using it with AI agents

Once installed, a single sentence in any agent invokes a gtrk skill:

| | |
|:--:|:--:|
| ![Calling gtrk from an agent, example 1](../assets/agent-example-1.png) | ![Calling gtrk from an agent, example 2](../assets/agent-example-2.png) |
| ![Calling gtrk from an agent, example 3](../assets/agent-example-3.png) | ![Calling gtrk from an agent, example 4](../assets/agent-example-4.png) |

`gtrk install` installs the 18 bundled CLI skills (`gtrk-oralcut`·`gtrk-long2short`·`gtrk-splitter`·`gtrk-matrix`·`gtrk-mg`·`gtrk-ai-drama`·`gtrk-style-maker`·`gtrk-transcript`·`gtrk-tools`·`gtrk-music-visualizer`·`gtrk-cover`·`gtrk-travel-recap`·`gtrk-live-slicing`·`gtrk-talking-head`·`gtrk-narration`·`gtrk-voiceover`·`gtrk-food-recap`·`gtrk-vlog-docu`) into the agents detected on this machine. The mechanism matches lark-cli: gtrk hands its local skill sources to the generic `skills` CLI, which owns agent detection, directory mapping and update rules; gtrk no longer hardcodes per-vendor paths.

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

> ⚠️ **Upgrading the CLI does not refresh the skills you already installed.**
> `npm i -g @gitruck/cli@latest` swaps the CLI package only; the copy under each agent's directory is still
> **the snapshot from your last install** — the agent keeps working from the stale wording, **and nothing errors out**.
> Refresh with `gtrk upgrade` (CLI + skills) or run `gtrk skills install` on its own.
>
> Since **1.1.3** this is no longer silent: the skill-backed commands (`oralcut`, `long2short`, `split`,
> `matrix`, `mg`, `subtitle`, `project`) print a one-off notice on **stderr** with the fix command when they
> detect that the installed skills lag behind the package; when they match, or cannot be judged, output is
> **empty**. Run `gtrk doctor` any time for the "Skill freshness" row, or set
> `GTRK_SKILL_FRESHNESS=off` to silence the whole thing.

`--agents` accepts agent IDs from both the upstream adapter and the gtrk supplement layer. Chinese agents already covered include `trae`, `trae-cn`, `codebuddy`, `qoder`, `qoder-cn`, `qwen-code`, `kimi-code-cli`, `iflow-cli`, `codearts-agent` and `lingma`, plus `workbuddy`, `qoderwork` and `comate` which upstream has not registered yet. Common shorthands — `qwen`, `kimi`, `iflow`, `codearts`, `tongyi-lingma`, `qoder-work`, `baidu-comate` — are mapped automatically. When upstream adds new agents, gtrk can use the new IDs without a release; if an existing script must hardcode a directory, `--dir <skills dir>` still gives you the compatible copy mode.

**Agent input UIs are not standardized**: Claude usually surfaces skill names in `/` completion; different Codex clients enter via `$`, `/skills` or a Skills panel; TRAE relies mostly on Skills settings, explicit naming or semantic triggering. So not seeing a Claude-style `/gtrk-*` dropdown does not mean the skill is missing. If a new skill does not show up, refresh the window or start a new session.

Then just say "**cut a version of this talking-head**", or explicitly pick `gtrk-oralcut` from your agent's Skills entry point. The agent will ask about the raw file, script and pacing, call `gtrk oralcut --json` to run the loop, verify the artifacts and tell you how to open all three formats. The full portable playbook is in [`AGENT.md`](../AGENT.md).

**Hand the whole chain to the agent**: it is not just the talking-head cut — keep going with "split the storyboard", "lay the B-roll", "lay the MG particles", "render the video", and the agent will pair each show-specific production skill with `gtrk split` / `gtrk matrix` / `gtrk mg` / `gtrk render` to run the entire **production pipeline**. **You just talk; leave the CLI typing to the agent** — the "Command reference" below exists so the agent can look up parameters, not so you type them in a terminal.

### Capabilities agents can drive (skill drives command)

**Each capability = one skill (the brain — you trigger it, it knows its place in the SOP and handles interaction) driving one gtrk command (the hands — deterministic mechanical work).** Production is an **ordered SOP with a user checkpoint at every step**, not a one-shot parallel fan-out — a `/gtrk-X` skill runs `gtrk X` at the right moment, with your confirmation:

| SOP | Driving skill (what you say) | Underlying command (what the agent runs) | What it does |
|:--:|---|---|---|
| ① | `/gtrk-oralcut` | `gtrk oralcut` | Smart talking-head cut → desktop client / Jianying / Premiere projects + transcript |
| ② | `/gtrk-splitter` | `gtrk split` | Storyboard dispatch → `dispatch.json` (A_ROLL/MG/AI_DRAMA/FILM_BROLL, four lanes) |
| ③ | `/gtrk-matrix` | `gtrk matrix` | **B-roll base · film/local-footage leg**: lays candidate tracks → **you adjust/choose** (toggle visibility in opencut) |
| ③ | `/gtrk-ai-drama` | (no command, pure authoring) | **B-roll base · AI scene-clip leg (same stage as matrix, not last)**: emits four-part description docs (backstory / characters / shots / source text, in Chinese and English blocks) → generate on any external platform and re-insert by hand (the artifact is description text with no mechanical tail, same as `/gtrk-style-maker`: skill only, no command) |
| ④ | (no skill) | (no command) | **Global frame-sampling composition check**: sample frames from the merged three-source base layer and have the user confirm the composition — a hard agent-discipline gate feeding ⑤'s placement decisions |
| ⑤ | `/gtrk-mg` | `gtrk mg` | **MG (incl. ov) goes on last** (stacked on the settled, composition-checked base layer) |
| — | `/gtrk-style-maker` | (no command, builds a show) | A one-time interview that builds your show's style system (skill family + show config, see next section) |
| ③′ | "**screen-recording PiP**" | `gtrk pip lay` | Mirror the talking-head rough cut's cut points onto a screen recording / second camera recorded in sync: lays a full-frame companion track + a muted picture-in-picture copy of the talking head (ellipse / rounded rectangle / heart / diamond / star mask, optional corner radius); purely local, zero billing; when alignment confidence is low it writes an alignment project for the client to drag into place, then `--resume` |
| — | (wrap-up) | `gtrk render` | Render a gtrk project locally → finished mp4 (overlays and MG particles included; particles that miss the cache are cloud-rendered and billed, `--no-particles` skips them) |
| ✂️ | `/gtrk-long2short` | `gtrk long2short` | Long-to-short rough cut: semantic segment selection + jump cuts → per-clip client/Jianying/Premiere projects (the raw file is never uploaded); **not part of the production SOP**, usable standalone at any time |
| 📝 | `/gtrk-transcript` | `gtrk transcript` | Local video / voice-over audio → one Markdown file with an agent-written summary, timecoded record and plain text; **not part of the production SOP** |
| 🧰 | `/gtrk-tools` | `gtrk tool <name>` | The single-shot tool family (image-to-camera-move / image & video matting …) — single request, single result, **not part of the production SOP**, usable standalone at any time |
| 🎵 | `/gtrk-music-visualizer` | `gtrk music-visualizer` | One song → a spectrum-visualizer video (template + optional background/cover + colour styling), **not part of the production SOP**, used standalone for audience acquisition |
| 🖼️ | `/gtrk-cover` | (no command, pure authoring) | The two-stage cover workbench: design diagnosis + text-to-image prompts in three sizes and two languages → you generate images on an external platform → an HTML5 typesetting workbench (drag/scroll fine-tuning, one-click export to multiple PNG sizes). Show-specific cover aesthetics are injected through the show config's `style.skills` (`produces:"cover"`); **not part of the production SOP** (it is the "stage zero" companion to distribution) |
| 🧭 | `/gtrk-talking-head` | orchestrates `gtrk audio` → `oralcut` → `split` → `matrix` → `mg` → `audio lay` → `subtitle lay` | **Talking-head chain blueprint**: one or more on-camera raw takes → external audio aligned and swapped in, multi-take stitching, rough cut, dispatch, B-roll / MG cards, BGM, subtitles → a client-ready project |
| 🧭 | `/gtrk-travel-recap` | orchestrates `gtrk tool audio_tts_clone` → `project init` → `split` → `matrix` → `mg` → `audio lay` → `subtitle lay` | **Travel-recap blueprint**: a folder of travel footage → the AI reads the footage, writes a three-act narration, you confirm once → voice-over / project / dispatch / B-roll / cards / BGM / subtitles run unattended → a client-ready project |
| 🧭 | `/gtrk-live-slicing` | orchestrates `gtrk long2short` (very long replays are segmented first) | **Live-stream slicing blueprint**: a multi-hour replay → segmentation (server-side 2 h hard limit) → topic list confirmed → a batch of per-clip rough-cut projects (gtrk + Jianying + Premiere), split-screen matched to the picture |
| 🧭 | `/gtrk-narration` | orchestrates `gtrk transcript` → `project init` → `split` → `matrix` → `mg` → `audio lay` → `subtitle lay` | **General narration blueprint (canonical for the narration chain)**: something long that carries its own timeline (a feature film, gameplay, a restaurant visit …) → distil the outline and highlights → retell it concisely as a narration project; travel recap and food recap are its vertical instances |
| 🧭 | `/gtrk-voiceover` | orchestrates `gtrk tool audio_tts_clone` → `project init` → `split` → `matrix` → `mg` → `audio lay` → `subtitle lay` | **Voice-over chain quick preset**: a finished script (or one the AI writes) → voice-over → automatic visuals → cards / BGM / subtitles → a client-ready project; for material with no timeline of its own (explainers, emotional radio, opinion pieces, product copy, round-ups) |
| 🧭 | `/gtrk-food-recap` | follows the `/gtrk-narration` chain | **Food-recap vertical blueprint (narration-chain example)**: a restaurant-visit / fly-on-the-wall long take or a cooking-process recording → distil the highlights and retell it as a Chinese food-narration project |
| 🧭 | `/gtrk-vlog-docu` | orchestrates `gtrk transcript` → `tool audio_tts_clone` → `split` → `matrix` → `mg` → `audio lay` → `subtitle lay` | **Documentary-vlog blueprint**: a batch of on-location footage → footage understanding, register choice and script, one sign-off → live-sound skeleton + narration voice-over + B-roll + subtitle layer + BGM run unattended → a client-ready project; alternates on-location sound with post-production narration, unlike the pure talking-head or pure voice-over chains |

> **Skill vs command**: `/gtrk-mg` is the **brain** — it knows it belongs at SOP step ⑤ (MG only after all three B-roll sources have landed and the composition is checked), asks for your confirmation, and resolves which particle type to produce from the show config; `gtrk mg` is the **hands** — purely deterministic lint + track laying. You trigger the skill by talking, and the skill runs the command for you.
> The 18 `/gtrk-X` skills above are **framework skills bundled with the CLI** (installed by `gtrk skills install`; the list is identical to the ones in "Using it with AI agents" and "Layout") — the 7 marked 🧭 are **composite blueprints** (one sentence runs a whole chain; they only orchestrate the single-command skills above and add no commands of their own); `/gtrk-long2short` independently drives long-to-short, `/gtrk-transcript` independently drives video/audio-to-transcript, `/gtrk-tools` covers only the single-shot tool family, `/gtrk-cover` handles covers, and none of the four belong to the production SOP; `/gtrk-ai-drama`·`/gtrk-style-maker`·`/gtrk-cover` are pure authoring skills (no command). Show-specific **visual style and content** come instead from your own show's production skills (created by `/gtrk-style-maker`, bound through the show config's `style.skills`) and are never hardcoded into these framework skills.

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

**Pipeline contract**: the framework presupposes nothing about aesthetics and is fully authoritative about pipeline interfaces. Skills whose artifacts enter the render pipeline must satisfy the corresponding contract (see [`contracts/`](../contracts/README.md), e.g. `gsap-emit v1` for HTML animation particles); a contract only constrains machine-decidable pipeline properties, and what the picture looks like is always yours.

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

### Enum catalog (`--refresh-catalog`)

`gtrk doctor` shows an “enum catalog” row: the CLI fetches the **complete set of public enum values**
from the server (subtitle styles and colours, language codes, project formats, rhythm presets,
task availability, …), stores it at `~/.gitruck/catalog.json`, and refreshes it every 24 hours.

With it, a bad `--subtitle-type` is rejected **before the upload starts**, with the currently valid
values listed. When the server adds a new style, you get it without upgrading the CLI.

```bash
gtrk doctor --refresh-catalog          # refetch now, ignoring the 24h freshness window
```

**Failing to fetch it never blocks you**: the CLI falls back to the last snapshot; with no snapshot at
all it **skips local validation and submits anyway**, letting the server decide — the server-side
whitelist is always the single source of truth. Set `GITRUCK_CATALOG_OFFLINE=1` to disable the fetch
entirely.

### Crash reports, and how to turn them off

When gtrk crashes (uncaught exception / unhandled promise rejection / a program defect reaching the top-level exit) it automatically sends one report so we can locate the defect. **On by default; you are told once, when you first configure the CLI.**

**What is sent, in full**: the error message, the error stack, a source tag (`cli`), the CLI version, how many times this crash accumulated, and — only when the crash happened during a cloud task — that task's ID.

**What is never sent**: your media files or their contents, project files and path listings, your scripts, your API key (the key's literal value and any `gc_…`-shaped token are replaced with `<KEY>` before sending), device identifiers, hostname, environment variables.

**Only crashes are reported, never expected failures**: missing file, invalid argument, insufficient credits, wrong command usage — none of the errors you can read and act on are ever sent.

Three ways to turn it off (any one of them, effective immediately):

```bash
gtrk init --no-crash-report          # persisted in config, off for good
```

```bash
GITRUCK_CRASH_REPORT=0 gtrk oralcut a.mp4   # environment variable, off for one run (takes precedence over config)
```

Or set `"crashReport": false` directly in `~/.gitruck/config.json`.

You can check the current state any time: the “崩溃自动上报” row in `gtrk doctor` shows on / off, and which of the two turned it off. With reporting off, the crash presentation and exit code are **exactly the same** as with it on — the switch only controls whether that one report is sent.

---

## Command reference

Common entry points: `gtrk oralcut` edits talking heads, `gtrk long2short` selects highlights, `gtrk transcript` transcribes media, and `gtrk project init` builds from voiceover. The per-source limit for `oralcut` / `long2short` is 2 hours; split longer replays first, as described in the [workflow guide](workflow.en.md). Use `gtrk <command> --help` for current options.

### `gtrk long2short` / `gtrk pip` / `gtrk qc` — Additional commands

- `gtrk long2short <input>`: select topics and jump-cut into per-clip gtrk / Jianying / XML projects. `--split-screen` uses a 720p proxy for smart split-screen; `--output-size` selects the aspect ratio; `--subtitle-out` writes captions for each clip. Run landscape and portrait separately; content determines the number of clips. See `gtrk long2short --help` for all options.
- `gtrk pip lay`: lay a simultaneously recorded screen or second camera against the talking-head cut points. Both sources need shared audio for alignment; low-confidence matches require calibration in the client before resuming. Use `gtrk pip lay --help` for inputs, shapes, positions and offsets.
- `gtrk qc <video>`: inspect flash frames, black/frozen frames, volume and synchronization. Add `--gtrk` for project context and `--fail-on` for pipeline gating. Findings locate issues; they do not automatically repair the video.

### `gtrk matrix --online` — External-platform search in current source

This entry exists in the current development workspace. Check `gtrk matrix --help` for availability in your installed version; cloud availability must also be confirmed.

| Option | Purpose and boundary |
| --- | --- |
| `--online` | Search external-platform B-roll; supported only for ad-hoc search or dispatch consumption, and mutually exclusive with `--local`. Ad-hoc search requires `--out <result.json>` for results and recovery records; dispatch consumption requires `--project` or `--dispatch`. This submits cloud work, not a purely local operation |
| `--platforms <list>` | Comma-separated `youtube,vimeo,tiktok,bilibili`; requires `--online`. Defaults to all four registered platforms. Results depend on service and source availability |
| `--online-session <name>` | Nonempty external-search batch name; requires `--online`. Continue within a batch; changing the name starts a new search and may incur new task charges |

### `gtrk transcript <local video|voice-over audio>`

Turns a local video or voice-over audio file into a multi-level Markdown transcript. It accepts local file paths only: video is extracted — and audio input transcoded — to 16 kHz mono audio on your machine, and only that derivative is uploaded. The original file is never uploaded, and URLs or platform video downloads are not supported.

```bash
gtrk transcript "D:/素材/采访视频.mp4"
gtrk transcript "D:/素材/采访视频.mp4" --lang zh-CN --out "D:/文字稿/采访.md" --json
```

By default it produces only `D:/素材/采访视频-transcript.md`, whose structure is fixed:

1. `## 总结` (Summary): the CLI marks it as pending, and `/gtrk-transcript` drives the agent to read the full text, generate it and write it back;
2. `## 文字记录` (Transcript record): readable paragraphs each starting with `[00:01:23]`;
3. `## 纯文本` (Plain text): the complete recognized text, easy to copy in one go.

Live pricing is queried from the website's price table under `asr` before the run; neither the CLI nor the docs store price numbers. With `--json`, stdout contains only `{ok,taskId,fileId,output,transcriptJson,summaryPending}`, where `output` points at that single Markdown file; `summaryPending:true` means `/gtrk-transcript` still needs the agent to write the semantic summary and replace the pending marker in place — the deliverable remains the same single file.

> With `--json` it additionally drops a sentence-timecoded `<name>-transcript.json` next to the source file (`utterances[]{id,text,st,ed}` + `material_id` + `text_hash` + `duration`, field-for-field aligned with the transcript structure `gtrk split` consumes), which the `gtrk project init --transcript` fallback path can consume directly. **Do not re-run ASR here on TTS-synthesized voice-overs** — `gtrk project init --tts-task` fetches the server-side sentence timecodes directly, zero ASR and zero extra billing.

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

### `gtrk oralcut-result <taskId> --out <dir>`

Fetches the report and the three project formats of an **already completed** task by `task_id` (with optional local rendering), **skipping preprocessing / upload / submission / polling** — use it when the report is lost or you want to pull the artifacts again on another machine, without re-running the cloud job.

| Parameter | Purpose | Default |
|---|---|---|
| `-o, --out <dir>` | Output folder | **Required** (no default since 2026-09-08; `--out .` = the current directory itself) |
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

### `gtrk patch <move|trim|split|set>` — element-level editing (the only way to edit a project)

Edit the timecode or parameters of a single clip / gap / particle. **Agents must not hand-edit `.gtrk` JSON** —
a clip carries **two parallel timecode representations** (`clip_st`+`clip_ed` and `clip_st`+`duration`).
Changing one without the other is a **silent failure**: the desktop client reads `clip_ed` first while the
backend does not strictly validate it, so nothing errors out yet the render uses a stale out-point.
This command handles identity synchronisation + frame alignment + a whole-file check before writing.

```bash
gtrk patch move  --project <dir> --clip c2 --to 5.0
gtrk patch trim  --project <dir> --clip c2 --out -1s
gtrk patch split --project <dir> --clip c2 --cut 5.5
gtrk patch set   --project <dir> --track audio:1 --at 3.0 --volume 0.5
```

| Flag | Purpose | Default |
|---|---|---|
| `--project <dir>` / `--gtrk <path>` | Project dir (auto-locates `gtrk/project.gtrk`) or an explicit path | — |
| `--clip <clip_id>` | Address by id. A video/audio **mirror pair** counts as one editing unit | — |
| `--track <kind:idx> --at <sec>` | Address by position (`track_st ≤ at < track_ed`). Mutually exclusive with `--clip` | — |
| `--to <sec\|Nf>` | Target position for `move` | — |
| `--in` / `--out` / `--set-in` / `--set-out` / `--slip` | The five `trim` semantics (first two relative, next two absolute, `--slip` shifts only the source window) | — |
| `--cut <sec\|Nf>` | Cut point for `split`. ⚠️ Distinct from the addressing flag `--at` | — |
| `--muted` / `--volume <gain>` / `--opaque` | Element-level parameters for `set` (`--volume` is linear gain, not dB) | — |
| `--total <sec\|Nf\|max>` | Top-level duration for `set` (project-scoped op, mutually exclusive with element addressing) | — |
| `--ops <file\|->` | Batch transaction: read once, compute all, validate all, write once; any failure writes **nothing** | off |
| `--dry-run` | Compute and validate only, do not write | off |
| `--json` | Machine-readable receipt on stdout (human logs go to stderr) | off |

> Time literals: seconds (`3.5` / `3.5s`) or frames (`105f`); relative values take a sign (`-1s`).
>
> The receipt carries `ops[].resolved`, a locator triple `{track, clip_id, track_st}` — use it on the next
> round to confirm you are still pointing at the same element.
> `preexisting[]` lists invariant problems that were **already in the file** (not caused by this run, not
> blocking); violations caused by this run mean **zero writes and a non-zero exit**.
>
> ⚠️ A gap cannot be addressed with `--clip ""`: the contract lets multiple gaps share that value, so it is
> not an address. Use `--track/--at` instead.

### `gtrk matrix` — B-roll retrieval + candidate track laying

**No positional argument = consume the dispatch**: reads the `film_broll` queue from `split/dispatch.json` → dual-endpoint retrieval → produces the candidate list `split/broll-plan.json`, downloads preview proxies, and lays N candidate tracks in the project (open it in opencut and toggle track visibility to compare and choose). **`matrix search "<query>"` = a one-off ad-hoc search** (independent of any dispatch). **`matrix fetch <clip_id...>` = pull raw footage during the fine cut** (project-independent; see below).

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
| `--out <file>` | Write ad-hoc results to a file; for `matrix fetch`, the raw-footage output directory (never the Jianying draft folder) | stdout / `./matrix-fetch/` |
| `--arrange <m>` | **B-roll arrangement route** — **picked automatically by material source; you normally do not pass it**: your own local footage → `cloud` (arranged in the cloud, billed by **arrangement volume**, with an estimate and a confirmation prompt first; `--yes` skips). Material from the asset matrix → `local` (arranged on your machine, not billed, unchanged byte for byte). `shadow` is an observation mode: your machine lays as usual while the cloud runs the same arrangement for comparison only. ⚠️ On the local-footage route `--arrange local` is not accepted (passing it is a parameter error), and if the cloud cannot deliver a result the command **fails outright** instead of quietly switching to a different algorithm. It is **not a way to save credits** either — asset-matrix material is billed for search. Both routes cost something; they just cost it at different steps | picked by material source |
| `--arrange-qc` | **Arrangement-time QC** (off by default): before anything is laid, check each beat's anchor sentence for whether the picture actually shows what the script says; if not, swap candidates and re-arrange, at most 2 rounds, then deliver and report honestly which lines still do not match. Zero rendering throughout — it replaces the "lay → render → look → re-lay → render again" loop. ⚠️ Judging goes through the material-understanding endpoint and is **billed per frame** (1 frame per anchor sentence per round); an estimate and a confirmation prompt come first (`--yes` skips). Orthogonal to `--arrange`: works on both the local and cloud routes | off |
| `--arrange-cost-cap <n>` | Hard cap on arrangement volume for a single cloud run: over the cap the server **refuses up front** — zero execution, zero charge (it does not cut off midway). Only meaningful with `--arrange shadow\|cloud` | uncapped |
| `--dump-request <file>` | **For troubleshooting**: write the **exact bytes actually sent** for the cloud arrangement request to this file. The server **does not keep your plan** (only a size summary), so when something goes wrong this file is the only thing that can reproduce the call — just send it to us. ⚠️ It **must not point inside the project directory** (projects get zipped, copied and synced around, and this file contains your beat names and search queries); with `--arrange-qc` each round writes its own file, round N landing at the same name plus `.roundN`. The machine-readable receipt is `lay.arrange_run.dump_request` | not written |
| `--explain` | **Emit the tuning gauges**: by default the machine-readable accounting gives only the empty-slot count `lay.dedup.emptySlots` (enough to tell whether your material pool is too thin); the rest of the tuning detail (how many of those were caused by window refinement, how many jump-cut waivers were exhausted, how many high-motion / blurry segments were used) sits behind this flag, and the human-readable log follows the same rule. It changes no decision — the project output is byte-for-byte identical | off |
| `--arrange-estimate-only` | **Estimate only, do not execute**: stop right at the cloud-arrangement billing confirmation, report the arrangement volume and return **successfully** (`ok:true` + `estimateOnly:true` — that is "I am deciding", not "I declined"). Zero cloud calls, zero changes to the project file. Machine-readable values live in `lay.arrange.units` / `lay.arrange.scale`. ⚠️ What it saves is **that one cloud call and its charge** (plus the candidate downloads and laying that follow), not the whole chain: the denominators of the arrangement volume still require reading the project, the plan, and re-projection. On the asset-matrix route it reports `applicable:false` rather than **0**. When given together with `--yes`, this flag wins | off |
| `--cut-align <ratio>` | Sentence-boundary snapping target ratio 0..1: `0.7` ≈ about seven in ten subtitle sentence starts land exactly on a shot cut, three in ten deliberately off (snapping all of them reads mechanical); `0` = off, back to the old rhythm-slot cutting. ⚠️ Sentence-level timecodes come from live `transcript` re-projection (same source as the keyword anchors), and **when re-projection degrades it silently falls back to the old behaviour and warns** — the snapping ratio does not hold for that run | `0.7` |
| `--gap-fill <mode>` | How holes in the main track of an audio-driven project get filled: `fast` = **leave as little black as possible** (relax the score floor and fill from the candidate pool → then extend neighbouring grains → then borrow unconsumed candidates across beats → then fill residual holes shorter than the minimum shot length with real footage → only pad black when a whole segment cannot be filled); `solid` = pad everything with black (so in fine-cut you can see at a glance "nothing matched here"); `none` = leave the gap as is. ⚠️ Under `fast`, borrowed footage is weakly related to that segment's script and sub-floor slots are quick cuts under 1.2s; both are reported in the log with `kind` `borrowed` / `subfloor` — **that is honest disclosure, not a defect**. `none` combined with main-track magnetic snapping in the client will swallow the gap and shift everything after it **out of sync with the voiceover** | `solid` |
| `--highlight-weight <w>` | `matrix lay` only: fold "is there anything worth watching" (information density / drama / emotional intensity / rarity) into candidate ranking, 0..1. **Orthogonal** to `--mark-weight` (how good the frame looks); the two weights are clamped to sum to 1. ⚠️ The highlight score reads the `describe` understanding cache, so **without a prior `describe` run this flag does nothing** — uncached candidates are treated as neutral and the weight is returned to similarity | `0` (off, zero regression) |
| `--decode-path <mode>` | `matrix index` only: decode path for scene detection, `auto` \| `gpu` \| `cpu` \| `full`. `auto` probes for hardware decoding and **degrades per asset** (recommended); `gpu`/`cpu`/`full` pin one tier and **do not degrade on failure** (for A/B comparison and troubleshooting). ⚠️ The default is still `full` (legacy behaviour) — you have to pass `auto` yourself to get the speedup | `full` |
| `--proxy-width <n>` | `matrix index` only: proxy decode width. ⚠️ Below this, fidelity degrades noticeably — **do not shrink it casually** | `384` |
| `--proxy-scaler <name>` | `matrix index` only: proxy scaling algorithm. Defaults to `neighbor` (point sampling, no filtering; measured faster *and* more accurate than `bicubic`). ⚠️ You basically only need to change this to run a comparison experiment | `neighbor` |
| `--exclude-recent <n>` | `matrix material --scope audio` only: avoid the last n BGM tracks already used. The history is **booked automatically** when `audio lay` writes to the track — you do not maintain it | `12` |
| `--no-exclude-recent` | Turn off the BGM avoidance above, allowing recent tracks to be reused | off (avoidance is the default) |

**`matrix fetch <clip_id...>` (pull raw footage during the fine cut, project-independent)**: for materials you have **searched with billing** (hits in the grant ledger), re-signs fresh download links for free by clip_id and lands them as `<clip_id>.<ext>` — when the rough cut is already exported to Jianying and one more B-roll is needed, you can pull the raw file locally and drag it straight in without going back to the client app. The flow is always **two-step**: pick clip_ids from `matrix search` → `matrix fetch` to pull (fetch itself is free of charge, performs no search, and has no confirmation gate). **Grants are persistent**: the 24h-expiring signature is no obstacle — a clip searched three days ago still fetches fine. Ungranted items are reported one by one as "not granted" with the way out (run one billed search for that keyword to obtain the grant) and never block the rest; one batch ≤ 500. **The initial scope covers video clip raws only** (the re-sign surface for image/audio materials is not open yet; such ids land in missing with a hint). Outputs never enter `.gtrk` and never land in the Jianying draft folder; material added inside Jianying does not flow back into the project (export is one-way).
| `--json` | Machine-readable: stdout carries only the result JSON | off |

> **Cloud arrangement keeps nothing on the server**: the projected plan you send up is **not stored**. What we keep is a size summary, the metering version and the recomputed amount — enough to settle a billing dispute independently, but nothing that reveals your material structure. The price of that is that **when something goes wrong we have nothing to reproduce it with** — hence `--dump-request <file>`, which keeps the exact bytes that went up **on your own machine**; send us that file when you need help. It is off by default and **refuses to write inside the project directory** (projects get zipped and copied around).
>
> Two protections sit in front of the endpoint, both answering **429 with zero execution and zero charge**: a per-key rate limit, and a check that recognizes "the same plan resubmitted over and over with different parameters". Transport retries send **byte-for-byte identical** request bodies and are never counted against either.
>
> **Beat windows are re-projected on the spot**: in dispatch-consumption mode, **before the first cloud retrieval**, each beat's `[track_st, track_ed]` is recomputed from "`transcript` × the current `.gtrk`", and retrieval, `broll-plan.json` and track laying all use the recomputed values (`--lay 0` obeys the same rule; ad-hoc `search` is unaffected). The timecodes in `dispatch.json` are only a **projection-time snapshot**, used as a fallback solely when re-projection is impossible — **so after editing the talking-head track you can run this command directly without re-running `gtrk split`**. `--json` always emits `reprojection:{mode,degraded,reason?,drifted,max_offset,shrunk,dropped}`; beats with **zero surviving span** after re-projection are skipped (no retrieval quota is burned on them and nothing is laid). If re-projection is impossible (missing transcript / project not found / no talking-head material on the main track) → it **degrades to the snapshot with a warning and a `--json` marker**, while retrieval and the plan still complete instead of hard-failing; behaviour for non-v1 projects is unchanged (the plan lands first, then the version gate exits non-zero).
>
> Candidates' `preview_url`/`cover_url` **are unsigned and never expire** (once the local proxy is on disk it is always reused); what carries a signature and expires in roughly 24 h is the **source `url`**, re-signed by the client's "confirm source clip" flow — **you do not need to re-run this command just to re-sign**.
>
> **Re-running strips and re-lays, but never touches tracks you edited**: candidate tracks are identified by "material prefix + last round's registration fingerprint", no longer by track number (saving in the client renumbers all overlay tracks). Once a candidate track is judged "edited by you" (a clip was changed, or you confirmed the source clip in the client so the material became `broll-raw-*`), this run **lays nothing at all**: no track is stripped, no track is appended, `.gtrk` is byte-for-byte unchanged, `broll-plan.json` is still produced, and the command reports "which track / what evidence / what to do next" and exits non-zero (`--json` emits `{ok:false, refused:[…]}`). Add `--force-relay` to force a re-lay.
>
> **Machine-readable accounting: `counts.results` is the pre-dedup number**: in `--json`, `counts.results` is always the **sum of retrieval-response rows across queries** (unchanged legacy semantics) — when 15 queries all hit the same material it reads 15, while the landed plan may hold only 8 rows covering a single material. To judge "how much footage is actually there", read the three keys emitted in dispatch-consumption mode: `counts.zero_yield` (queries that **truly yielded nothing**, decided on the **retrieval response** being empty rather than by scanning the plan for `results: []` afterwards — in-beat dedup folds a hit into a sibling query of the same beat, and folding ≠ zero yield), `counts.plan_results` (the actual number of result rows **after the plan lands**, deduplicated) and `counts.distinct_clips` (distinct `clip_id` count inside the plan). These three appear **only in dispatch-consumption mode**; the `counts` of ad-hoc `matrix search` and `matrix lay` are byte-for-byte unchanged (**absence means "no such concept here", not "measured as 0"**). On the laying side it likewise emits `lay.beatsWithCandidates` (beats that have candidates) and `lay.emptyBeats` (**the list of zero-candidate beats** — spans with no footage to lay at all); the two always satisfy `beatsWithCandidates + emptyBeats.length = the plan's total beat count`.
>
> **Material-on-disk self-check**: after writing back the project it verifies that every `materials[].path` really is on disk (**read-only, reports without touching anything**). Relative paths are always resolved against the **directory containing the `.gtrk` file** (`<output>/gtrk/`). `--json` emits `integrity:{ checked, counts, dangling:[…], danglingReferenced, danglingOrphan, external:[…], noPathIds:[…] }` — `dangling` is the complete list of **broken references** among project-owned materials (registered but missing on disk), each flagged with **whether the timeline references it** and where (a referenced one means that span has no media to show, far worse than an orphan); missing absolute paths are counted separately as `external` (an unmounted external drive looks like this too, so it does not pollute the main verdict); http(s) materials are only counted and **no network requests are made**. **This informs, it does not block**: broken references do not change `ok`, do not change the exit code, and no material entry or file is deleted. They are usually historical residue (e.g. an interrupted "confirm source clip" download); the fix is to re-confirm the source clip in the client or delete that clip. Runs that never wrote back (`--lay 0` / refused / missing project) **emit no `integrity` field** — absence means "not checked this time", not "checked and clean".
>
> **The solid black bed track**: by default a solid black track is laid beneath all candidate tracks and above the talking-head main track (`struct_meta.broll.black_track` records its `track_index`), covering the full landed beat envelope so that during B-roll (including the empty spots on candidate tracks) the talking-head picture underneath is not exposed. **The cost is "black holes"**: wherever candidate tracks are not filled, pure black covers the talking-head, and track laying computes exactly that — `--json` always emits `lay.blackBedHoleSec` plus per-span `lay.blackBedHoles`, and a non-fatal warning is added when a single span is ≥ 3 s or a single beat's ratio is ≥ 15 % (it does not change the exit code or block laying). Use it to adjust `--score-floor`, switch to `--no-black-bed`, or patch by hand in the client. The bytes land at `assets/builtin/solid-000000-<W>x<H>.png`, sharing an id namespace with the client's built-in solid material and reused idempotently. Do not delete it by accident when removing candidate tracks; to swap footage, drag onto a candidate track's clip and **not onto the black bed** — since client 0.2.10 (force-updated release on 2026-07-31) **dropping onto the black bed is rejected outright with a message**. On clients older than 0.2.10 (force update not yet pulled) the old behaviour silently creates a new video track and inserts there; if it lands in the lower half you cannot see it in the preview at all (one `Ctrl+Z` undoes the whole thing) — restart the client first to pick up the force update. If you do not want the black bed, re-run with `--no-black-bed` and it is stripped clean.

**Local-footage mode (`matrix index` / `--local`)**: footage does not have to live in the cloud library — retrieve and lay tracks straight from your local footage folders (video and images mixed):

```bash
gtrk matrix index --dirs <folder-or-file,...>                  # ① build a slice-free index: content-fingerprint incremental, resumable; renames/moves are not recomputed
gtrk matrix --local --dirs <folder-or-file,...> --project <dir>  # ② local retrieval + track laying (--lay 0 = plan only; pass a single media file to narrow the search scope to it)
gtrk matrix lay --project <dir> [--plan <path>]                # ③ consume the (edited) plan and lay tracks, zero retrieval cost
```

- **Repeat the flag when a path contains an ASCII comma**: `--dirs` / `--materials` split on ASCII commas by default; when a path carries one, repeat the flag instead (`--dirs "A" --dirs "B"` — it **accumulates**, it does not overwrite). A whole string that exists on disk is never split, and the full-width comma "，" never participates in splitting. **When enumeration reports `0/0`, check this first**, then check the folder for broken symlinks.
- **Your footage never leaves your machine**: only 512px sampled frames are sent to Gitruck Cloud's own embed endpoint for vectorization, discarded on arrival; results reference your local originals by absolute path (no downloads, no proxies). Indexing is metered by frames actually sampled (pre-held before the run, settled to actual usage afterwards); text-side retrieval costs zero credits.
- **Images are first-class**: images are indexed, retrievable and layable; when selected, an image goes through cloud `image_move` and lands as a 5-second camera-move video — **the image itself does go to the cloud** (2 credits per image, summarized for confirmation before laying; same image + same params is reused forever, never re-billed). Zero images to the cloud → `--no-image-broll`.
- **No material reuse**: within one laying round each material unit is used once globally (local video per scene, images per file); when candidates run dry, slots stay empty rather than repeat; `--dedup-scope material` tightens to file level.
- **Projects containing local footage cannot cloud-render**: submission is rejected (`local_broll_cloud_render_rejected`) — produce locally in the desktop client or via `gtrk render`.
- **Optional atoms**: `matrix describe --plan <path> [--top-k N]` / `--materials <a,b>` understands candidates on demand (VLM description / tags / quality mark / watermark·subtitle·black-border·blur signals; 1 credit per frame (**async task billing**: pre-deducted on submit → settled on completion, auto-refunded on failure; Gitruck internal members are exempt, detected automatically at run time — with `--json`, `credits_estimated` is the actual charge and `credits_would_be` the list price), results injected into the plan and cached locally, cache hits are free, >20 frames triggers a confirmation guard). **One describe speaks for one segment, not the whole candidate**: in `--plan` mode each candidate is sampled at a single frame (`segments[0].best`), the result carries the scope anchor `describe.at_sec` (seconds on the material timebase), and the run reports "describe coverage = frames understood / total **segments** carried by the understood candidates" (`describe_coverage` in `--json`) — injecting N entries does not mean those N candidates were all looked at; `--source-window <start,end>` filters by source-time window (only with `--local`; the film-commentary pattern "segment N of the narration gets footage from around segment N of the film"); `matrix lay --mark-weight <0..1>` blends describe's quality mark into candidate ranking (fused score = sim×(1-w)+(mark/100)×w; reorders only, never changes admission; candidates without a cached mark are treated as neutral).
- **Highlight rubric**: `--highlight-rubric <text|@file>` (same flag on `describe` and `lay`; ≤2000 characters; `@<path>` reads from a file, which is the main form since a rubric is multi-line). It tells the highlight score (`--highlight-weight`) **what to judge by** — each vertical blueprint carries its own (food judges portion contrast and visible prices, travel judges rare landforms and extreme weather). **Omit it and the field is not sent at all**: the server falls back to its own domain-agnostic default, byte-for-byte identical to behaviour before this flag existed. Highlight scores are cached in **per-rubric buckets**: switching rubric rescores without invalidating or overwriting the objective description cache. `describe --plan` pins the run's `rubric_hash` into the plan and `lay` reads that same bucket automatically (no need to pass it twice); if the two disagree `lay` **fails hard** instead of silently picking one — scoring against the wrong rubric is undetectable after the fact. ⚠️ Rescoring under a new rubric still re-sends the frames (billed per frame): a text-only rescore channel needs server support and does not exist yet.
- **Index knobs and score scale**: `--scene-threshold` tunes scene-split granularity, `--stability-threshold` collapses static-camera scenes to fewer sampled frames, `--rebuild` forces a rebuild (describe caches are kept); the index is not portable across machines (keys are absolute paths — just re-run `index` on the new machine). Local score scale differs from the cloud's (a perfect hit can score as low as ~0.25), so do not raise `--score-floor` on cloud instincts.

**`gtrk matrix material "<query>"` (general tri-state material search)**: the second line alongside the B-roll search above, returning a download link for the **whole material** (not a segment) — `--scope clip|image|audio` (default `audio`, the BGM use case), `--commercial-only` searches commercially usable material only (**an explicit opt-in switch — off by default**), `--min-duration/--max-duration` picks by finished-cut length, `--top-k` (default 5, server cap 50), `--diversity`, `--json` for machine reading, `--out` to write a file.

> ⚠️ **`is_copyright` means "may this be used commercially", not "is this under copyright"**: `true` = **commercially usable** (owned ∪ licensed), `false` = **not commercially usable**.
>
> **Do not read `false` as "no copyright, use it freely" — it means exactly the opposite.** The decisive counter-example: concept material (other people's copyrighted works) is ingested with a hard-coded `is_copyright=0`; if the field really meant "is under copyright", that batch would have to be 1.
>
> This warning comes from a real incident: on 2026-09-02 an AI operator **deliberately picked `false` twice in a row** as the "safe" option and laid non-commercial material into 5 projects, while the only safe value, `true`, was actively avoided. So under `--json` the CLI now **derives a plain-words label `copyright_label`** per result (`"可商用"` = commercially usable / `"不可商用"` = not) — derived from `is_copyright`, always in the same direction, absent whenever `is_copyright` is absent. Read either key; never infer from the field name.
>
> The field exists **only on the matrix-member endpoint**: on the public endpoint its absence does not mean "not commercially usable" — the server already restricts that endpoint to commercially usable material at the source (absent = nothing to judge; the CLI reports the absence honestly and never fabricates a value).
>
> **Default scope (⟲ 2026-09-06)**: the matrix-member tier searches the **whole library by default** (`copyright_scope=all`, including non-commercial and concept material) — that breadth is exactly what membership buys, so the command never narrows it for you, and the bundled skills must not drop `is_copyright:false` candidates "just to be safe" (they do label every result honestly). Pass `--commercial-only` yourself when you need commercially usable material only.

Orchestration recipes (pure matching / describe-then-lay / time-window / footage-first scripting / three-layer stacking) and the plan-editing contract live in the bundled skill `/gtrk-matrix`.

### `gtrk mg` — MG motion-graphics particles (lay / lint / status / render)

Consumes the `dispatch.mg` dispatch landed by `gtrk split`, laying html-particle assets produced by **your show's MG skill** into the `.gtrk` project's `beat_track`. Four modes are dispatched by the first positional word: **no argument = lay**, `mg lint <file>` = single-file validation, `mg status` = orchestration dashboard, `mg render <file>` = standalone particle cloud render (project-independent; the fine-cut supplement channel). The old name `gtrk rrv` remains a deprecated alias (it prints a notice; prefer `gtrk mg`).

| Parameter | Purpose | Default |
|---|---|---|
| `--project <dir>` | The oralcut / split output folder (locates `split/dispatch.json` and the `.gtrk` project) | — |
| `--dispatch <path>` | Explicit `dispatch.json` path (fallback for non-standard layouts) | Derived from `--project` |
| `--only <beat>` | Run a single beat only (takes a **beat id** such as `B12`, not a `composition_id`; the main particle and its `-aux<n>` overlays are selected together). **True incremental merge**: only the matched particles are re-laid, and every other already-laid particle on the track (including your manual tweaks) is preserved as is | all |
| `--lint-only` | Lint only; lay nothing and write nothing back | off |
| `--replace-all` | Explicitly authorize a **full track reset**: no incremental preservation, the whole track is stripped and re-laid — **this deletes every other already-laid particle on the track** | off |
| `--duration <sec>` | **Required in render mode**: the explicit duration anchor (seconds) — standalone mode has no slot envelope, so this value is at once the lint envelope, the output duration and the billed duration | — |
| `--format <fmt>` | Render-mode output format: `qtrle` only for now (Jianying-readable transparent MOV; `webm` is explicitly refused — Jianying cannot read VP8-alpha) | `qtrle` |
| `--out <dir>` | Render-mode output directory (never writes into the Jianying draft folder — dragging into Jianying is your move) | `./mg-render/<composition_id>/` |
| `--yes` | Render mode: skip the billing-estimate confirmation | off |
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
- **render** (`gtrk mg render <particle.html> --duration <sec> [--out <dir>] [--yes]`): renders a single particle in the cloud, **independent of any project**, into a Jianying-readable qtrle transparent alpha MOV (the fine-cut supplement channel — when the rough cut is already exported to Jianying and one more motion graphic is needed, you can add it without going back to the client app). The chain = lint upfront (envelope = `--duration`; any fatal item is blocked locally, zero submission, zero billing) → **billing-estimate confirmation** (live price lookup; the CLI has no local HTML render engine, so the cloud billed task is the only path for standalone particles; `--yes` skips the prompt) → inline submission to the cloud → `<composition_id>.mov` landed with `task.json`/`result.json` breadcrumbs (recoverable by task_id after a crash). **Scope**: qtrle only for now (`--format webm` is explicitly refused — Jianying cannot read VP8-alpha), 1920×1080 particles only (the contract has no portrait/odd-canvas opening), and `--duration` is required. The output never enters `.gtrk` and never lands in the Jianying draft folder; qtrle is lossless and relatively large, suited to seconds-long particles. Note it shares a word with `gtrk render` (full-video rendering) but is a different thing.
- **fetch** (`gtrk mg fetch <query|block> [--top 3] [--all]` / `gtrk mg fetch --pick <block> --slot <beat> --project <dir>` / `--pick <block> --as <composition_id> --duration <sec> [--out <dir>]`): the **neutral particle source** from the HyperFrames registry — MG without a show skill. Candidate mode is **offline** (the snapshot ships with the package, pinned to a source commit) and lists 2–3 blocks per query with compat flags and poster links; pick mode fetches the block through three sources in order (our mirror first, then jsdelivr, then GitHub raw; 5 s each, **sha256-verified per source**, nothing is written if all three fail) → eight mechanical rewrites (`<template>` wrap / id rename / drop data-start and fit the slot / sink the solid backdrop into a child / swap GSAP to the contract CDN / swap fonts to a CJK font provable in our runtime mirror / fit duration to the slot / letterbox scaling, never stretch) → `gtrk mg lint` (fatal items block the write) → lands at `<project>/mg/<composition_id>.html`. **A skeleton is not a deliverable**: the returned `editable` (copy / number arrays / colors) MUST be rewritten for the beat and the show before laying. The contract currently accepts 1920×1080 particles only; `excluded` blocks are refused, `review` blocks (canvas / house-rule 8 shapes) can be fetched but need a real render check. `GITRUCK_MG_REGISTRY_BASE` overrides the fetch prefix.

`--json` output: `{ ok, mode:"lay"|"lint"|"status", … }` (each mode carries its own fields, e.g. `laid` / `skipped` when laying, per-beat status for `status`). Laying mode additionally carries **`track_total`** (how many laid particles currently exist on the track), **`kept`** / **`kept_ids`** (how many are **left over from the previous round** and not re-laid this time, plus their `composition_id` list) and **`removed`** (how many old self-produced particles were stripped this run) — `laid` (this run), `track_total` (total on the track) and `kept` (left over) **must be read together**, and `track_total = laid + kept` always holds. Reading `laid` alone makes "lay 1, strip 20" look identical to "patch in 1", and reading only the first two hides the cost that "a few particles on the track are not from this round" (`kept_ids` and `skipped` overlap: something that failed to land this round is still there from the previous one). When not fully green it also carries a machine-readable **`reason`**: `skipped` (some were not laid) / `empty_queue` (**write-back refused**, the project was not modified, with `refused:true` and `blocked[]`) / `no_project` (project missing, nothing laid). Runs that actually wrote back also carry **`integrity`** (the material-on-disk self-check, identical in name and shape to `gtrk matrix`; see the previous section).

> **Exit codes**: an `ok:false` from laying or `--lint-only` **always comes with a non-zero exit** (including the ordinary mid-loop case of "some beats were skipped"). Agents should not read non-zero as "the command crashed" — judge by `reason` / `skipped`.

> **Aux overlay particles**: if `gtrk split` dispatched an `overlay` particle in some beat's `aux_layers`, it derives a `<beat>-aux<n>` composition entry into `dispatch.mg` — `gtrk mg` lays it too, giving you "a main visual on the base track plus a transparent conceptual diagram stacked on the same span".
> **Dual-read compatibility**: `dispatch.mg` (also reads the old `rrv_mg`), the source directory `mg/` (also reads the old `rrv/`), the material prefix `mg-` (also reads the old `rrv-`) — projects created before the de-branding need zero migration.

### `gtrk project init` / `gtrk audio lay` / `gtrk audio tighten` — audio-first project atoms (voice-over first)

Project entry points that start from **a voice-over** instead of a talking-head raw: with the voice-over in hand (TTS-synthesized or self-recorded), `project init` builds the `.gtrk` project, and `gtrk split --project` continues the production pipeline as usual; `audio lay` adds an audio track (BGM/score) to any project; `audio tighten` tightens the pauses between sentences in the voice-over.

| Command | What it does |
|---|---|
| `gtrk project init --tts-task <task_id>` | **Main path**: references a completed `audio_tts_clone` task — the server hands over the audio and sentence timecodes directly (zero ASR, zero extra billing); the audio download lands in the project's `audio/` |
| `gtrk project init --audio <voice-over> --transcript <transcript.json>` | **Fallback path**: your own voice-over audio plus its sentence-timecoded transcript as a pair (produced by `gtrk transcript <voice-over> --json`; for TTS-synthesized voice-overs take the main path instead of re-running ASR) |
| `gtrk audio lay --project <dir> --file <bgm.mp3>` | Appends an audio track to the project; **idempotent same-source replacement** (re-running with the same source replaces instead of piling up tracks; zero-reference protection when stripping the old one); `--volume <0..1>` (default 0.1, bed volume — the contract carries linear gain only, never dB; the client's volume panel shows -20.0, the same scale on both sides), `--offset <ms>` sets the in-point |
| `gtrk audio lay … --beat-align` | **Climax anchoring** (`audio_music_analyze`, billed once): pins the BGM’s emotional peak `H` (the server’s `highlight.time`) onto the cut’s climax `A`; the mapping is always `track_sec = A + (bgm_sec − H)`. **Both sides long enough ⇒ zero tiling** (exactly one clip); only a short side is tiled outward, with seams snapped to downbeats (the two hard track boundaries are cut without snapping). `A` comes from the criterion chain over `struct_meta.split.beats`: elevation → container flip → callback closure → `0.75×total` fallback, and **the CLI reports which rung was used — the fallback is explicitly flagged as a guess**. Without a key / on analysis failure / when the track has no highlight it degrades to no anchoring and the command never fails over it |
| `gtrk audio lay … --beat-align --climax <track-sec>` | Climax **escape hatch**: always overrides the chain above. Out of range (≤ `--offset` or ≥ the project end) or non-numeric **errors out immediately** rather than falling back silently — an explicitly wrong value should be visible at once. Must be used together with `--beat-align` |
| `gtrk audio lay … --no-loop` | No tiling: with `--beat-align` it lays only the anchored span and leaves head/tail silence (**the silent seconds are reported**); without `--beat-align` it keeps a single pass instead of looping to fill the project |
| `gtrk audio tighten --project <dir>` | Tightens the pauses **between sentences** in the voice-over track (**purely local, zero billing**): only silence that straddles a sentence boundary is compressed — **within-sentence breaths and quoted original-audio spans are left alone** — and the output honestly reports how many within-sentence breaths were skipped. `--keep <sec>` silence to keep after tightening, `--min-silence <sec>` leave anything shorter untouched, `--boundary-tol <sec>` tolerance for "sits on a sentence boundary", `--dry-run` report how many spots and how many seconds would be compressed without writing. For the three defaults see `gtrk audio tighten --help` (measured, accepted values — tune them for another subject or voice) |

`project init` also takes `--canvas <WxH>` (default 1080x1920), `-o/--out`, `--reupload`, `--no-open` and `--json` with the same semantics as `oralcut`; with `--json` both commands emit a single-line result JSON on stdout (human logs go to stderr).

> ⚠️ **`--beat-align` was redesigned wholesale on 2026-09-02** (change `redesign-beat-align-climax-anchor`). The old implementation pushed the whole BGM back by `firstDownbeat` seconds — it analysed the **BGM’s own timeline**, which has no consumer on the project timeline at all, so the net effect was **paying for one cloud analysis in exchange for an equally long silence at the head of the cut**.
> ⇒ **Artifacts produced with `--beat-align` are no longer byte-reproducible**; the default path without that flag is **byte-for-byte unchanged**.

> **Run `tighten` before laying tracks**: it changes the voice-over track's length, and `gtrk split` / `gtrk matrix` reproject beat timecodes against the project as it stands — tighten first and you save a round of rework. To get it right at synthesis time instead, in-house voices accept `--fragment-interval` during TTS (see `audio_tts_clone` below); cloud voices do not support that parameter, which is when you tighten after synthesis instead.

### `gtrk tool <name> [inputs...]` — the single-shot tool family

Standalone single-request capabilities, kept separate from the pipeline's lane commands (`oralcut`/`split`/`matrix`/`mg`). **A top-level command dispatched by the first positional word** (no parent/child commands): `gtrk tool <name> [inputs...]` runs a tool (multi-file image tools accept several paths, and the order is the assembly order), `gtrk tool list` lists them all. One tool = one thin descriptor (input category / payload assembly / artifact mapping / billing / availability gate), sharing a runner that performs "validate → upload (fingerprint cache, auto-chunked ≥ 256 MiB) → submit → poll → stream-download to disk → `task.json`/`result.json` breadcrumbs" — adding a tool means adding one descriptor, never writing orchestration.

**Output-directory convention**: tools that take an input file default to `<input-name>-<tool-name>/` **next to the input**; `input=none` tools (e.g. `audio_tts_clone`) default to `<tool-name>-<timestamp>/` **under the current directory**. Both can be overridden with `--out <dir>`. When the default name collides with an existing directory a `-2`/`-3` suffix is appended, and artifact files colliding inside one directory get the last 6 characters of the taskId appended — **always take the path from the returned `outDir` / `files`, never reconstruct it from the name** (an explicit `--out` never grows a numeric suffix; re-running the same input overwrites idempotently).

| Tool | Input | Output | Billing | Status |
|---|---|---|---|---|
| `image_move` | One image; optional `--motion` picks one of 26 camera moves | Camera-move video (geometry derived from the source orientation: landscape 1920×1080 / portrait 1080×1920) | Queried live before the run | Live |
| `image_matting` | One image | Transparent-background png (`--param` can request a backing plate) | Queried live before the run | Live |
| `image_blackborder_remove` | One local image | Image with black borders removed | Queried live before the run | Live |
| `image_canvas_adapt` | One local image; optional target width/height and `normal` / `rectangle` / `square` | Aspect-adapted image | Queried live before the run | Live |
| `image_purify` | One local image; optional `full_screen` / `region` and region boxes (only material you have the rights to process) | Image cleaned of watermarks, logos or overlays | Queried live before the run | Live |
| `video_matting` | One video (**≤ 10 minutes**, uploaded as-is with no proxy) | Transparent-background webm | Queried live before the run | Live |
| `video_blackborder_remove` | One local video | Video with black borders removed | Queried live before the run | Live |
| `video_canvas_adapt` | One local video; optional target width/height, clip range, canvas mode and audio-free output | Aspect-adapted video | Queried live before the run | Live |
| `video_stabilizer` | One local video; optional `fast` / `exp` / `turbo` | Stabilized video | Queried live before the run | Live |
| `video_vaporwave` | One local video; the filter takes an exact preset name | Vaporwave-filtered video | Queried live before the run | Live |
| `video_purify` | One local video; optional `full_screen` / `subtitle` / `custom` / `region`, `ffmpeg` / `raft`, a normalized ROI and region boxes with optional time ranges (only material you have the rights to modify) | One cleaned video | Queried live before the run | Live |
| `video_upscale` | One local video (**≤ 1 minute**); optional `2` / `3` / `4`× and `Reality` / `Anime` | One upscaled video | Queried live before the run | Live |
| `video_interpolate` | One local video; optional `2` / `3` / `4`×, with no extra one-minute limit | One frame-interpolated video | Queried live before the run | Live |
| `video_segment` | One local video; optional `--detector content\|adaptive`, `--threshold` | Shot-range structure in `result-output.json` (structured data, not a downloadable file) | Queried live before the run | Live |
| `video_ai_segment` | One local video; optional `--segment-mode scene\|shot_type\|narrative\|subject` | Semantic shot structure in `result-output.json` (structured data, not a downloadable file) | Queried live before the run | Live |
| `video_motion_cut` | One local video | Camera-move / highlight segment structure in `result-output.json` (structured data, not a downloadable file) | Queried live before the run | Live |
| `video_speaker_detect` | One local video; optional `--language`/`--max-faces-per-frame`/`--detect-body`/`--track-sample-fps` (GPU heavy) | Visible-speaker structure in `result-output.json` (the time base follows the server output) | Queried live before the run | Live |
| `video_face_track` | One local video; optional `--sample-fps`/`--max-faces`/`--min-face-ratio`/`--enable-body-match`/`--similarity-threshold`; `time_ranges` goes through `--params-json` (GPU heavy) | Person id / time span / trajectory structure in `result-output.json` (the time base follows the server output) | Queried live before the run | Live |
| `audio_tts_clone` | **No file**: one of `--text`/`--text-file` (≤ 5000 characters) plus a required `--speaker`; optional language/format/speed/segmentation/subtitles/**sentence pause** (`--fragment-interval <sec>`, **in-house voices only**; cloud voices **return an error** rather than silently ignoring it — the valid range is enforced server-side and stated in that error) | Voice-over audio wav/mp3 (plus optional subtitles); billed by character count — the unit and unit price come from what `gtrk tool list` shows live | Queried live before the run | Live |
| `video_ai_subtitle` | One video or audio file; `--language <code>` required; optional `--translate-language`, `--need-render`, `--need-pure`, `--subtitle-type`, `--subtitle-color`. By default only locally extracted audio is uploaded (the raw file never leaves your machine) | `.ass` subtitles + optional burned-in / subtitle-stripped `.mp4` + `result-output.json` (summary + word-level timeline) | Queried live before the run | Live |
| `subtitle_translate` | One **subtitle file** `.ass` / `.srt`; **both** `--language <code>` and `--translate-language <code>` are required; optional `--output-format`, `--line-mode`, `--bilingual`, `--subtitle-type`, `--subtitle-color`, `--canvas <WxH>`. No speech recognition | Translated subtitles `.ass` or `.srt` + `result-output.json` (entry counts + degradation flags) | Queried live before the run | Live |
| `video_translate_dub` | One video or audio file (**≤ 120 minutes**, uploaded whole); **all three of** `--language <source>`, `--translate-language <target>`, `--speaker <clone or voice code>` are required; optional `--ref <reference audio or video>` (only with `clone`; cloning someone else's voice requires that person's consent), `--ref-lang`, `--no-keep-bgm`, `--fit-policy`, `--speed-band <min,max>`, `--subtitle-mode`, `--subtitle-type`, `--project-formats <comma-separated>` (default: `.gtrk` only; add `jianying` to get a Jianying draft placed straight into your Jianying drafts folder), `--jianying-draft-dir`; valid values are decided server-side. Only the audio is replaced — the picture stays as it is (no lip sync); long sources take 15+ minutes | Dubbed video `<input-name>-dub.mp4` (`.mp3` for audio input) + `dub.wav` / `bgm.wav` + `.srt` subtitles + `transcript.json` + project files in per-format subfolders (`gtrk/`, `jianying/` …) + `result-output.json` (dub alignment report; includes `errors` when a side artifact is missing, without failing the run) | Queried live before the run | Live |
| `video_long2short_pro` | One long video (uploaded whole); `--language <code>` required; optional `--output-language`, `--main-topic`, `--output-size`, `--no-jump-cut`, `--duration-pref`, `--max-clip-sec`, `--split-screen`, `--split-orientation`, `--speed-factor`, `--no-camera-move`, `--no-subtitle`, `--subtitle-translate-language` | Finished clips `clip{i}.mp4` + the human-readable report `clips.md` (including polish-degradation details) + `result-output.json` | Queried live before the run | Live |
| `audio_separation` | One audio file; optional `--mode fast\|turbo` | Vocal and accompaniment audio (one or two items, depending on what is returned) | Queried live before the run | Live |
| `audio_speaker_split` | One audio file; optional `--only-struct` | Per-speaker `.wav` stems + a `spoken_list` timeline (`result-output.json`) | Queried live before the run | Live |
| `audio_stretch` | One audio file; optional `--semitones <n>`, `--speed <n>` (> 0) | Pitch/tempo-shifted audio | Queried live before the run | Live |
| `audio_noise_reduce` | One audio or video file; optional `--prop-decrease 0..1` | Denoised audio | Queried live before the run | Live |
| `audio_silence_remove` | One audio file; optional silence threshold and retained length | Silence-trimmed audio | Queried live before the run | Live |
| `piano_audio_to_midi` | One audio file | A MIDI file `.mid` | Queried live before the run | Live |
| `piano_audio_enhance` | One audio file | High-quality WAV + accompanying MIDI (two artifacts) | Queried live before the run | Live |
| `image_to_square` | One image; optional `--max-line <px>` (≤ 20000) | Square image | Queried live before the run | Live |
| `image_to_live` | One image | A short video of about 4 seconds `.mp4` (silent); or an Android motion photo `.jpg` plus the same clip as a companion `.mp4` | Queried live before the run | Live |
| `image_classic_template` | **Several images** + a required `--main-title`; optional subtitle/mode/ratio/quality/count/layout | Finished cover/collage (text/pic/render groups, possibly several images) | Queried live before the run | Live |
| `image_vertical_stitch` | **Several images** (order = top-to-bottom stitching order) | One vertically stitched long image | Queried live before the run | Live |
| `video_split_screen` | **2–16 video segments** (multiple positionals); the precise tier uses `--clips-json` (entries `{input:0-based index, begin_time_ms, end_time_ms, crop}`, millisecond time base); nine optional layout/aspect/audio parameters | One split-screen video (its length matches the shortest segment) | Queried live before the run | Live |
| `mad` | One material folder (3–10 videos) + optional `--bgm` | An AE master-composition project `.jsx` (AE only) | Only `--bgm` triggers a live price query | Live |

> Prices come from `gtrk tool list --json` and the anonymous live query printed to stderr before execution; this README stores no price snapshot. `video_matting` probes duration with ffprobe before uploading and rejects anything over 10 minutes outright (nothing is uploaded or submitted — trim it first).
> `mad` is the family's first **local-type "purely local tool with optional cloud extras"**: it runs without a key and triggers no billed job (technique data is delivered through a cloud manifest and cached in `~/.gitruck/mad-cache`, so **the first fetch needs the network and afterwards it runs offline**); only `--bgm` beat-syncing needs a key and triggers one cloud beat analysis. Three degradation tiers (key + beat sync / no key or bad BGM → fixed tempo / cloud failure → degraded) never crash. It produces only `.jsx` and supports AE only.

The seven shared video tools — black-border removal, aspect adaptation, stabilization, vaporwave, cleanup, upscaling and interpolation — accept only the server's current `video_ext`: `.mp4`, `.avi`, `.mpg`, `.mov`, `.flv`, `.mxf`, `.mpeg`, `.ogg`, `.3gp`, `.wmv`, `.h264`, `.m4v`, `.ts`; `.mkv` and `.webm` are rejected locally. Inputs must be local file paths — the CLI does not download remote videos.

- `gtrk tool list [--json]` — list every tool (name/description/input/output/live price/status); `--json` emits a single-line machine-readable array (including dynamic `billingHint`/`pricing`). **Works without an API key**; prices are queried anonymously through a public endpoint, and on failure the full list is still shown with an unavailable marker.
- `gtrk tool image_move ./photo.jpg [--motion zoom_in_center] [--json]` — image to camera move; artifacts land in `photo-image_move/`. `--motion` picks the camera move explicitly (26 values: 8 pans `up_to_down`/`down_to_up`/`left_to_right`/`right_to_left` plus four diagonals, 9 zoom-in anchors `zoom_in_{up,down,left,right,left_up,right_up,left_down,right_down,center}`, 9 zoom-out anchors `zoom_out_` at the same positions); when omitted the server picks one automatically. `--param width=1080 --param height=1920` overrides the derived geometry.
- `gtrk tool image_matting ./portrait.jpg` / `gtrk tool video_matting ./clip.mp4` — image/video matting.
- `gtrk tool image_blackborder_remove ./photo.jpg [--json]` — automatically crops black borders from one image.
- `gtrk tool image_canvas_adapt ./photo.jpg --canvas-width 1080 --canvas-height 1920 --canvas-type rectangle [--json]` — image aspect conversion; omitting the canvas parameters uses the server defaults. Per the actual runtime contract the canvas mode accepts only `normal`, `rectangle` and `square`, not the `fit` from older docs.
- `gtrk tool image_purify ./photo.jpg [--json]` — clean watermarks, logos or overlays from an image you have the rights to process.
- `gtrk tool image_purify ./photo.jpg --purify-scope region --purify-region 0.02,0.02,0.15,0.08 [--json]` — remove a box directly: no recognition, **everything inside the box is processed**; smaller boxes that fit the element tightly give better results.
- `gtrk tool video_blackborder_remove ./clip.mp4 [--json]` — automatically crops black borders from one video while keeping the original audio.
- `gtrk tool video_canvas_adapt ./clip.mp4 --canvas-width 1080 --canvas-height 1920 --canvas-type rectangle --clip-start 12 --clip-end 60 --without-audio [--json]` — video aspect conversion; `--clip-start/--clip-end` are start/end frame numbers, omitted fields use the server defaults, and the canvas mode accepts only `normal`, `rectangle`, `square`.
- `gtrk tool video_stabilizer ./clip.mp4 --stabilizer-method turbo [--json]` — video stabilization; supports `fast`, `exp` and `turbo`, where `exp` is experimental and you should check the result yourself.
- `gtrk tool video_vaporwave ./clip.mp4 --vaporwave-filter "灼熱苦夏" [--json]` — add a vaporwave filter using an exact preset name; omitting it explicitly uses `愈漸升溫`.
- `gtrk tool video_purify ./clip.mp4 --purify-scope custom --purify-method ffmpeg --purify-roi 0,0.78,1,0.2 [--json]` — clean a video you have the rights to modify; the ROI is a normalized `x,y,w,h` and is only used together with `custom`. `raft` supports videos under 20 minutes, `ffmpeg` has no such limit; restoring occluded content is not promised.
- `gtrk tool video_purify ./clip.mp4 --purify-scope region --purify-region 0.8,0.02,0.18,0.08,0,5 --purify-region 0.3,0.85,0.4,0.1,120 [--json]` — remove boxes directly; repeat the option for more boxes (up to 16), each optionally followed by `start,end` in seconds (omit `end` to run to the end). No recognition — **everything inside the box is processed, including the main subject**; `ffmpeg` blurs the box while `raft` repaints it, and tighter boxes give better results. `--purify-region` only works with `region`.
- `gtrk tool video_upscale ./clip.mp4 --upscale-times 3 --upscale-type Anime [--json]` — experimental video upscaling; input up to 60 seconds, neither side may exceed 4000 px after scaling, supports `2`, `3`, `4`× and `Reality`, `Anime`.
- `gtrk tool video_interpolate ./clip.mp4 --interpolate-multiplier 3 [--json]` — frame interpolation; supports `2`, `3`, `4`×, does not apply the one-minute limit from older docs, and neither side of the source may exceed 4000 px.
- `gtrk tool video_segment ./clip.mp4 [--detector adaptive] [--threshold 27] [--json]` — mechanical shot segmentation; produces **structured** `result-output.json` (`scene_list` with each range's start/end/duration), not a downloadable file.
- `gtrk tool video_ai_segment ./clip.mp4 [--segment-mode shot_type] [--json]` — semantic shot segmentation; produces `result-output.json` (`categories[].shots[]` with shot size, tags, descriptions and second-level timecodes).
- `gtrk tool video_motion_cut ./clip.mp4 [--json]` — camera-move / highlight segments; produces `result-output.json` (`cut_points[]` with frame numbers, second-level timecodes and motion features).
- `gtrk tool video_ai_subtitle ./clip.mp4 --language zh [--translate-language en] [--need-render] [--subtitle-color 湖蓝]` — AI subtitles: `--language` is required, and it produces `.ass` subtitles + `result-output.json` (LLM summary + word-level timeline). **By default only locally extracted audio is uploaded** (the raw file never leaves your machine, and the geometry is sent along with the request); `--need-render` switches to **burning in locally with ffmpeg** (it errors out if `思源黑体 CN Bold` (Source Han Sans CN Bold) is missing rather than substituting another font); `--need-pure` needs the picture, so adding it uploads the whole video. The `subtitle_type`/`subtitle_color` enums and `content` are documented in the cloud API docs, and `--params-json '{"content":{...}}'` passes them through.
- `gtrk tool subtitle_translate ./movie.ass --language zh-CN --translate-language en-US [--bilingual] [--canvas 1080x1920]` — AI subtitle **translation**: move existing subtitles into another language; **both language parameters are required**. **The line between this and `video_ai_subtitle` is the input shape**: to recognize subtitles from audio or video use `video_ai_subtitle`; to move an existing `.ass`/`.srt` into another language use this one (no ASR re-run, and your existing proofreading is preserved). `--line-mode keep` keeps the timeline line for line with the input (so the track can directly replace the original), while the default `resegment` reads more naturally but changes line counts and timecodes. `.srt` files carry no canvas information, so **always pass `--canvas` for portrait output**, otherwise lines are wrapped for landscape and may run past the edge. Style options only apply to `ass` output; combining them with `srt` output is rejected server-side before any charge.
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
- `gtrk tool image_to_live ./photo.jpg [--output-format motion_photo]` — bring a still photo to life. By default the artifact is a silent `.mp4` video of about 4 seconds; `--output-format motion_photo` instead delivers an **Android motion photo** (a single `.jpg` with the clip embedded after the still image, so a gallery plays it on long-press), plus the same clip as a companion `.mp4`. Both formats cost the same. Compatibility: Android galleries that support the standard recognise and play it; **iOS does not** and shows a plain still image; a few Android models may only ever show the still.
- `gtrk tool image_classic_template a.jpg b.jpg c.jpg --main-title "新品速览"` — title + several images into a cover/collage; `--output-pic-count`/`--output-text-count` are clamped to ≤ 20 by the server.
- `gtrk tool image_vertical_stitch top.png mid.png bottom.png` — stitch several images vertically in the order given.
- `gtrk tool video_split_screen a.mp4 b.mp4 --output-ratio 16:9` — simple tier: automatic split-screen layout over the whole clips (reaction / side-by-side comparison).
- `gtrk tool video_split_screen a.mp4 b.mp4 --clips-json '[{"input":0,"begin_time_ms":0,"end_time_ms":5000},{"input":1,"crop":{"x":0.1,"y":0,"width":0.8,"height":1}}]'` — precise tier: specify each segment's millisecond range and normalized crop box by 0-based index; the same file can appear several times to fill several windows.
- `gtrk tool video_speaker_detect ./talk.mp4 --language zh-CN` — detect who is speaking and when on screen, emitting structured JSON (GPU heavy).
- `gtrk tool video_face_track ./talk.mp4 --params-json '{"time_ranges":[{"begin_time":0,"end_time":30000}]}'` — face tracking / identity clustering, optionally limited to time ranges (**in milliseconds**; GPU heavy).
- `gtrk tool audio_tts_clone --text "欢迎收听本期节目" --speaker narrator` — text to voice-over audio (the voice list is in the website docs).
- `gtrk tool audio_tts_clone --text-file 稿子.txt --speaker sweet_female --output-format mp3` — long-form synthesis; by default it follows the speed and segmentation tuned for the chosen voice.
- `gtrk tool mad ./素材 [--bgm 歌.mp3] [--duration 20] [--seed 42] [--technique name,…] [--refresh] [--json]` — one-click MAD: scan the material folder → select techniques → a single `.jsx` (run it once in AE 2020+ to get the master-composition project). `--seed` makes it reproducible; `result.json` records the seed, data version, degradation tier and chosen techniques.
- `gtrk tool mad --technique <name | alias | pid,…>` — build from only the named techniques (without it, selection is rule-based sampling). An ambiguous or unknown name fails with a candidate list and writes nothing; a named technique with no windows in the pool is reported and skipped, the rest still build.
- `gtrk tool mad --search <keyword> [--json]` — look up the technique catalog without building anything: substring match over technique names, aliases and categories, listing name, category, `pid`, catalog frequency and pool window count. Mutually exclusive with `--technique`; both are free of charge and need no API key.
- Common flags: `--out <dir>` overrides the output folder, `--param k=v` (repeatable) / `--params-json '<object>'` pass cloud parameters through, `--reupload` ignores the upload cache, `--json` is machine-readable, `--ffmpeg-path <dir>` points at an ffmpeg directory.
- Cloud-type tools without a key → an error pointing you at `gtrk init`. A failed artifact download (e.g. an expired link 404) → `result.json` records `errors` with `ok=false`, and `task.json` is kept so you can recover by `taskId`.
- Cleanup, upscaling and interpolation are long-running GPU jobs, and their descriptors poll for up to 4 hours. A wait timeout does not mean the job was cancelled; keep `task.json` / `result.json` and recover by `taskId` instead of re-running and paying twice.

The companion skill is `/gtrk-tools` (one skill covering the whole tool family).

### `gtrk render <project.gtrk>` — render the finished video locally

```
gtrk render <gtrk> [-o <out.mp4>] [--crf <n>] [--codec <c>] [--ffmpeg-path <dir>]
                   [--no-qc] [--no-particles] [--particle-concurrency <n>] [-y|--yes]
                   [--no-open] [--json]
```

Treats the `.gtrk` as an EDL and renders it with local ffmpeg. **Footage always comes from the local originals** (`materials[].path`); the cloud never produces the finished file.

**What gets composited**: the base track (the lowest `track_index` that is not the black bed) plus every audio source, then **every visible overlay layer** stacked in contract z-order (ascending `track_index`, larger = closer to the front) — overlay video tracks (B-roll candidates, AI re-enactment) and the MG particles on `beat_track`.

- **Visibility reads the `hidden` field only** (the client's "eye" toggle): a hidden track stays out of the cut entirely and is reported. The renderer never guesses which track belongs in the picture.
- **When several candidate tracks are visible, the topmost one wins** (exactly what the client preview shows). To pick a different one, hide or delete tracks in the client.
- Missing overlay footage (e.g. B-roll proxies not fully downloaded) **degrades instead of blocking**: that clip is not composited, a warning is printed, and the render still completes.

**The particle half is billed** (the only cloud egress of this command):

| Topic | How it works |
|---|---|
| Why the cloud | The CLI has no HTML render engine; particle pixels are authoritative in Gitruck Cloud's Hyperframes. Only the **particle HTML text** is uploaded — never the footage itself |
| Metering | **unique particles × cache misses** (`html_render_simple`, per minute). A particle used N times on the timeline is baked once |
| Cache | `<project dir>/.tonghe-cache/particles/<sha256>.mov`, sharing **the same key and location** as the client's Jianying export chain ⇒ whatever either side bakes, the other reuses |
| Confirmation | Any miss triggers an estimate (total / unique / misses / billed minutes) and a prompt; `--yes` skips it. **A full cache hit never prompts** (a free operation should not add friction) |
| `--json` | With misses and no `--yes`, the command **refuses** (machine mode has no stdin; it will not silently submit a billed task) |
| Escape hatch | `--no-particles` renders particle-free at zero cost; overlay video tracks are **still composited** (that part is purely local) |
| Declining | Exits with zero cloud calls and zero file writes |

`--particle-concurrency <n>` (1–8, default 6) tunes particle render concurrency.

The `--json` result carries `particles: {total,unique,cached,rendered,billedMinutes,skipped[]}` and
`overlay: {layers,particles,hiddenSkipped,missingMaterialSkipped,particleUnavailable}` — **everything skipped has a machine-readable path**, so "65 particles laid, none in the cut, exit code 0" cannot happen quietly.

A QC pass runs automatically afterwards and writes `.qc.json` (`--no-qc` skips it); QC findings are reported but never change the render's exit semantics (use `gtrk qc --fail-on` for a hard gate).

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
- `gtrk skills recommend [--scene <id>] [--json]` — third-party skill catalog: without `--scene` lists the ten scenes (hook / mg-explainer / kinetic-text / data-viz / map / ai-drama / collage / caption / principles / technique); with a scene prints entries by tier (purpose / install command / license and dependencies / register command). **Recommend, never bundle**: the catalog ships with the package with a snapshot date, no network, no state; stars and licenses are as of the snapshot, installing is your call. GPL / AGPL / non-commercial / unlicensed / MCP-SaaS-only skills are excluded. The catalog also lists Gitruck's own first-party MG layout-technique family (`--scene technique`, entries marked `origin: first-party`): techniques are not lane producers; the agent picks them per slot at the MG step.
- `gtrk skills add <owner/repo> [--skill <name>]... [--produces MG|AI_DRAMA|FILM_BROLL|script|none] [--column <id>] [--agents ...] [--all] [--copy]` — installs a third-party skill through the generic `skills` adapter and, on success, **appends** `{id, ref: "<owner/repo>#<skill>", produces, status: "third-party"}` (`"first-party"` for first-party entries) to the show config `style.skills` (idempotent per ref, nothing is registered on failure; `--produces` defaults to the catalog value, repos outside the catalog register with `routing:"none"`), after which `gtrk mg` / `/gtrk-ai-drama` resolve it by `produces`.
