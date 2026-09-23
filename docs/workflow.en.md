# From footage to an editable project

[Back to README](../README.en.md) · [Command reference](reference.en.md) · [简体中文](workflow.md)

## Choose an entry point

| Input | Entry point | First deliverable |
| --- | --- | --- |
| One or more talking-head recordings, optionally with external audio | `gtrk-talking-head` Skill; `gtrk oralcut` for a rough cut only | Aligned, joined and roughly edited project plus transcript |
| An existing script | `gtrk-voiceover` Skill | Voiceover, sentence timing and an audio-driven project |
| Podcast, interview, course or livestream replay | `gtrk-long2short`; `gtrk-live-slicing` Skill for long replays | A separate project for each highlight |
| Film, gameplay, travel or restaurant footage | `gtrk-narration`, or travel/food presets | A retold script, voiceover and assembled visuals |
| Location footage with live sound to preserve | `gtrk-vlog-docu` Skill | A documentary project alternating live sound and narration |

The per-source limit for `oralcut` / `long2short` is **2 hours**. Longer sources are rejected before extraction or upload; split long replays first. Tutorials: [talking heads](https://hocassian.feishu.cn/wiki/Y6Odw4Kz5iPKMxkOOPJc6FyOnpe) · [voiceover](https://hocassian.feishu.cn/wiki/CdpewYDOmialPLkjOmacI97Wnfd) · [long to short](https://hocassian.feishu.cn/wiki/Gls1wTebVi1tpDkeaK8cINqbnMb) · [narrated videos](https://hocassian.feishu.cn/wiki/CmtRwmqzYi5dRtkWKgDc7ApWnre).

## Follow the production order

1. **Set the content and production plan.** Check footage, script, aspect ratio, voice and visual direction. Listen to and adjust a voiceover before building its timeline.
2. **Create the project and transcript.** Rough-cut, select highlights or build from voiceover. Review pacing and content before packaging.
3. **Arrange visuals.** Dispatch segments and search platform or local footage. B-roll and AI reenactment clips are both base visuals and can be prepared separately.
4. **Settle the composition.** Choose candidate tracks in the client and inspect faces, subjects and safe areas. You may explicitly defer missing AI clips, then revisit affected compositions when they return.
5. **Add motion graphics.** Place titles, diagrams and transparent overlays around the settled footage without obscuring its subjects.
6. **Music, captions and delivery.** Add captions after the timeline settles, then preview, check and export video or supported editing projects.

Optional stages can be skipped. Quick mode groups key decisions; ask for step-by-step progress when you want to review each stage. Checkpoints and cost confirmations follow the relevant Skill.

## Where to chat and where to edit

Conversations currently happen in your own AI agent; the desktop client has no built-in AI chat. The agent creates or updates `.gtrk` through the CLI. The Windows client opens that same project for preview, selection and refinement.

Give further requests to your agent or make manual changes in the client. Scripts can also render an existing project with `gtrk render`; opening the desktop client is not a prerequisite for every render.

## Deliverables and export boundaries

| Deliverable | How to use it | Boundary |
| --- | --- | --- |
| `gtrk/project.gtrk` | Open in the desktop client | Keeps the multitrack structure and supported motion graphics information |
| Jianying drafts from talking-head / long-to-short cuts | Configure the draft folder during setup; open from Jianying's project list | Requires both fixed filenames, `draft_content.json` and `draft_meta_info.json` |
| `xml/premiere.xml` from those cuts | Import into Premiere | Describes the corresponding rough cut; it does not promise lossless transfer of every later client effect |
| Jianying drafts exported by the client | Continue refining a packaged project | Preserves supported tracks and captions; graphics may be baked into video and are no longer editable as the original HTML |
| MP4 from `gtrk render` | Playback, review or publishing | Composites visible video overlays and graphics; hidden tracks stay out. This command does not export Jianying drafts |

Client-specific elements, complex effects and third-party formats are not universally interchangeable. Check the rendered video for final appearance, and keep `.gtrk` plus its media for further editing.

## Uploads and costs

- **Talking-head and long-to-short project workflows:** originals stay local. Extracted audio is uploaded by default; visual assistance or smart split-screen uses a compressed proxy.
- **Local B-roll:** original media stays local. Understanding may send sampled frames; cloud arrangement uses structured information and is billed under its own rules.
- **Individual cloud tools:** upload requirements vary. Cloud video processing may require the video itself.
- **CLI rendering:** video composition is local. Uncached graphics require cloud rendering with a cost prompt. `--no-particles` skips those graphics while still compositing other visible video overlays.
- **AI generation:** external model services, separate production desks and your agent follow their own pricing.

Prices and free allowances may change. Check the [billing guide](https://hocassian.feishu.cn/wiki/Iq9NwC3briQ2TJkSrzPcm5Jensd) and runtime pricing.

## Recovery and troubleshooting

| Situation | Action |
| --- | --- |
| Skills do not appear | Open a new agent session; use `gtrk skills install` if needed. Not every agent uses a `/` menu |
| Configuration, connection or runtime problem | Run `gtrk doctor`; check `gtrk deps status` before explicitly installing missing FFmpeg assets |
| Draft is missing in Jianying | Check the draft root and both fixed filenames listed above |
| Talking-head task completed, but results are missing | Use the recovery command below, or read `result.json` in the output folder before rerunning a cloud job |
| A long task timed out | Timeout does not mean cancellation. Keep `task.json` / `result.json` and query or recover by task ID |
| Upgrade needed | `gtrk upgrade` upgrades the CLI and refreshes Skills; `npm i -g` alone does not refresh agent Skills |
| An older project has compatibility problems | Check the [CHANGELOG](../CHANGELOG.md) and follow the relevant version instructions |

```bash
gtrk oralcut-result <taskId> --out <output-directory>
```

See the [command reference](reference.en.md) for parameters, JSON receipts, billing confirmation and recovery limits.
