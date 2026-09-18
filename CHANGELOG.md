# 更新日志

## 未发布

### 加：推荐目录收一方 MG 排版技法族（add-first-party-technique-catalog-entry）

`gtrk skills recommend` 多一个场景 `technique`：同合云自己的排版技法族（首个技法 doc-reveal：文献页叠放 / 发牌 / 局部强调）。技法不是栏目 MG 生产 skill——`gtrk skills add` 装完登记为 `routing:none` 且 `status: "first-party"`，由 agent 在 MG 步按槽位取用；显式 `--produces` 绑车道会照登记并告警一行。人读输出对一方条目印「一方维护」不印 star；`--json` 每条多 `origin`。`/gtrk-mg` 手册在「无匹配」与「有匹配缺省不用」两处各加一句指路，公约 §三‴ 补一方口径。

### 改：`gtrk mg lint` 补体积规则（add-particle-html-size-lint）

颗粒 HTML 超过 2,000,000 字符（客户端颗粒运行时的硬上限，超了在客户端永远加载不出来）现在判致命 `4-html-size`：铺轨跳过该 beat、`mg render` 不提交零计费；命中即短路，其余检查项不跑。超过 500,000 字符给非致命 `4-html-size-heavy`（客户端每次 seek 整份快照回传，体积直接决定预览帧率）。
报错点名最大的一段 data: URI（类型、字符数、解码字节数、落点），给「按实际显示尺寸裁剪缩放后再内嵌」的改法；没有 data: URI 的超限如实归因为标记与脚本本身。契约 `contracts/gsap-emit-v1.md` 铁律 4 增补⑤，`gtrk-mg` 图纸 lint 节同步。

### 加：视频译制配音 `video_translate_dub`（link-video-translate-dub-cli）

`gtrk tool video_translate_dub <视频或音频> --language <源语种> --translate-language <目标语种> --speaker <clone 或音色代号>`：
把原片里的话翻译成目标语种，用所选音色或克隆原片说话人的声音逐句重新配音，画面保持原样（不做口型同步）。
单条最长 120 分钟，超了上传前直接拒；按分钟计费，运行前实时查价。
可选 `--ref <参考音频或视频>`（仅 `clone` 有意义，克隆别人的声音须先取得本人同意）、`--ref-lang`、`--no-keep-bgm`、`--fit-policy`、
`--speed-band <最小,最大>`、`--subtitle-mode`、`--subtitle-type`、`--project-formats <逗号分隔>`；各参数的合法取值以服务端为准，CLI 不内置枚举。

产物：`<输入名>-dub.mp4`（音频输入为 `-dub.mp3`）、`dub.wav`、`bgm.wav` 与 `base.mp4`（有则落）、字幕 `.srt`、逐句对齐记录 `transcript.json`、
工程文件按格式分目录（`gtrk/`、`jianying/` …），`result-output.json` 为配音对齐报告。
提交时自动带上原片与产物目录的本机路径，各格式工程里的素材都指向本机文件，打开即用。要剪映草稿加 `--project-formats gtrk,jianying`：草稿两件套齐全后自动放进剪映草稿目录（新增 `--jianying-draft-dir`，缺省读 `gtrk init` 配置或自动探测，与 `gtrk oralcut` 一致）；CapCut 草稿留在产物目录。服务端尚未升级时工程里仍是占位名、剪映草稿缺 meta，终端会各打一行提示。
字幕、逐句记录、工程文件等附带产物偶尔缺项时只打一行 WARN，任务照常判成功。

### 加：工具族通用「附加输入文件」

工具可声明除主输入之外的本地文件参数（首个使用者是上面的 `--ref`）：任何上传之前先本地校验文件存在与扩展名，
主输入之后上传，`--reupload` 同样生效，`task.json` 记录 `extraInputs`；没声明的工具行为与面包屑不变。
产物文件名带子目录时自动建父目录。

### 改：共享参数说明与超时长报错

`--language` / `--translate-language` / `--speaker` / `--subtitle-type` 的说明改为不绑定单一工具的表述，参数名不变。
视频类工具输入超时长的报错改为「输入时长超过 N 分钟上限，请先裁剪或分段后再提交」。

### 文档：`gtrk-tools` 图纸写明 `audio_tts_clone` 可选出字幕（link-add-tts-subtitle-output-cli 3.2）

输入列补 `--subtitle-format <fmt>`（可选、缺省不出、不额外计费、取值以服务端为准），产物列补另产 `tts-<音色代号>.srt`（服务端降级时不留空文件）；
新增守卫 `test/skill-tools-tts-subtitle.test.mjs` 按列校验，防止文案被改回。

### 加：文字模板候选态可按分类过滤（add-text-template-category 2.2）

`gtrk mg fetch --source text [检索词] --category 打字机` 先按目录分类圈池子再检索，JSON 多返回 `category` 与 `categories`；
分类不存在时零候选并列出可用分类，不会退回成「不过滤」。取块态给了 `--category` 就要与模板分类对得上，对不上直接拒。
⚠️ `--category overlay|fullscreen` 是 registry 路的不透明度品类，文字模板路收到这两个值会当场报错，并指路到 `--slot <beat> --project <dir>` 派单模式。

### 改：B-roll 云端编排版本不一致时，告警不再列「命中旧幂等条目」这条成因（link-arrange-decision-pin-echo 9.7）

服务端已把决策层版本钉进幂等键，且入键前写下的条目已随 24 小时有效期排空（2026-09-16 生产核实：
新鲜请求与逐字节重放都回传当前版本、重放不二次计费）。这条成因在当前部署下不可能发生，继续列出只会把排查引向不存在的地方。
`IDEM_KEY_PINNED_DEPLOYED` 改为 `true`；服务端若回滚到版本钉入键之前，须改回 `false`。

## 1.2.5（2026-09-14 定版，2026-09-15 发布）

> 下面四条补录于 2026-09-16：**它们随 1.2.5 一起发出去了，但当时漏写了用户面条目**。
> 判据取自 registry 拉回的 `@gitruck/cli@1.2.5` 包体（`dist/index.js` 里的运行期串），
> 不是本地源码——本机全局 `gtrk` 是指向开发仓的符号链接，照它判会把未发的算进来。
> 已发的 1.2.5 代码切在 `69a1f51`：`gate-mg-visual-job` 与「本地编译补校验」**不在这一版里**。

### 修：`maxWidth` 的文字层换画幅会被挤窄（fix-text-ir-maxwidth-shrink）

编译器给带 `maxWidth` 的文字层补 `width:max-content`。原先只给 `max-width`，
块级盒会占满父宽，居中与右对齐算出来的落点因此偏。

### 加：满屏槽位必须真有实心底（gate-fullscreen-slot-needs-solid-bed）

`dispatch.mg` 的 `category:"fullscreen"` 表达「这段 MG 盖住画面」，此前**声明了也不会兑现**——
信号打过（`x-category-opaque`），但走灰字 `log.info`、夹在一模一样的 `x-soft-alpha` 之间、
`exit 0`，等于没打。现在拿不出满幅实心底就**致命拒落盘**，并给两条出路（改 `overlay`／补 `canvas.bg`）。
配套：`dispatch.mg[].bg` 这个一直没有消费方的字段接上了——取块时钉进 IR 的 `canvas.bg`，
声明当场兑现。**判据只取产物不取出身**：按「这颗是不是文字模板」写的闸，在加档上线当天就会错。

### 修：`mg lay` 拿会漂的 `track_index` 当自产轨主键（fix-mg-lay-track-identity）

契约明写它会漂、MUST NOT 当身份判据；客户端保存时按 `10+i` 重发，还会按有无物化视频劈轨。
失败形态是「剥一半」（静默重复叠加）与「误剥用户轨」。改用内容指纹，口径照抄 `matrix-lay`
那边早修过的成熟实现。

### 改：随包文字模板目录刷到 `v2026-09-15.1` / 103 件

### 修：`mg fetch --source text --slot` 派单模式必败（fix-mg-fetch-text-slot-identity）

真机上这条命令**从来没成功过**：

```bash
gtrk mg fetch --source text --pick tfx-type-terminal --slot B05 --project <工程>
# → composition_id "B05" / lint 致命 1-cid-expect / 不落盘
```

两处不对。① `--slot` 收的是 beat id（`B05`），而派单里的 `composition_id` 是
`<工程slug>-<beatId>`（`t07-B05`）——铺轨与 `mg lint --dispatch` 都按后者对账，旧实现却把前者
直接当 id 用，`dispatch.json` 一个字没读。② 取到的模板 HTML 原样送 lint，而模板内的
`data-composition-id` 恒为模板 id、期望 id 恒为 `<slug>-<beat>`，两者永远不等 ⇒ 必然致命。

文字模板是 `ir` 态、**不能直改 HTML**（改一字节就掉成 `detached`，云端再也调不动），
所以钉 id 的合法路径只有一条：改内嵌 IR → 走 `mg compile` 同一条本地编译链重编。现在命令替你做：

- 派单模式的 `composition_id` / 坑位包络 / `category` 全部取自 `dispatch.mg` 那条（与中性块
  `registry` 路共用同一份 `matchSlot`，两条路不再各写一份）；
- 内嵌 IR 的 `id` 钉成期望 composition_id，`canvas.duration` 钉到**坑位包络 + 0.3s 余量**
  （铁律⑦），且**原本贴在模板末尾的层跟着钉**——不钉的话坑位长于模板时，那些层会在原时长处
  被隐藏，后半段元素凭空消失；
- 重编产物自证仍须是 `ir` 态，否则报错零落盘；`id` 与时长都没改时**原字节落盘**，不重编。

独立模式同病一并修：`--as` 过去只改文件名、不改颗粒内部 id；`--duration` 在 text 路被**静默忽略**
（命令面照收、代码里根本没这个字段）。现在 `--as` 改写 IR `id`、`--duration` 钉 `canvas.duration`，
且 `--slot` 与 `--duration` **互斥**（派单的包络由 `track_st` / `track_ed` 定，显式给时长会与它打架）。

另两条顺带：镜像块自身不是 `ir` 态时**报错零落盘**（那是发布事故，静默落一颗改不动的颗粒，
用户要到 `mg edit` 被拒才发现）；派单 `category` 透传给 lint，槽位派 `fullscreen` 而模板是透明叠加时
报**非致命**的 `x-category-opaque`——不拦落盘，但提醒你给这颗补一层全幅实心底。

## 1.2.4（2026-09-14）

### `gtrk mg` 文字模板三口：`fetch --source text` / `compile` / `edit`（add-text-template-source）

同合云自己 clean-room 重写的文字特效模板库进了 CLI。与中性块 `registry` 那条路**刻意不同**：
文字模板 MUST NOT 走机械改写——中性块来自第三方、要替字体换色板才合规；文字模板的块**自带 IR**，
一旦直接改 HTML 字节，它就从 `ir` 态掉成 `detached`，云端再也调不动。改内容只有两条路：

```bash
gtrk mg fetch --source text 打字机                       # 候选态：只列不取（--offline 用本地目录）
gtrk mg fetch --source text --pick tfx-title-typeline    # 取块态：三源择优取，逐字节校 sha256
gtrk mg compile ./mg-fetch/tfx-title-typeline.ir.json    # 改完 IR 重编译（L0，本地跑、0 积分、零请求）
gtrk mg edit ./mg-fetch/xxx.html --say "打字机快一倍，副标改成青色" --n 3   # 云端改写（2 积分/候选）
```

`--n` 只收 1 或 3，**它就是计费单位数**。改写被拒绝（模型说「词表里做不到」）同样计费——
那是为了不让「拒绝」变成免费试探，但拒绝理由会原文给你，不会只丢一句失败。

### 文字模板目录：随包兜底 + 远端择新 + 8 个人话分类（add-text-template-source / add-text-template-category）

目录走「远端择新、随包兜底」：扩批是纯写 IR 的轮次，不该被 CLI 发版卡住，所以**随包那份会过期，
这是设计**——运行时按 `version` 择新，随包只在三源都不可达时顶上。本版随包 **v2026-09-14.11 / 103 件**。

分类从 37 个收成 8 个：`F`/`M`/`R` 是内部来源编号（喵影家族 / MAD 图鉴技法号 / 参考视频），
用户看不懂，而且 93 件摊出 37 个分类里有 16 个只有 1 件。改由**目录下发** `category`
（快照脚本算，两端只读不算——各算一份会漂且漂了不报错），判据是规则不是手工名单：
满 7 件才配独立、其余进「其他」、总数 ≤8。`family` 保留供溯源、仍进检索干草堆
（老用户按 F02 搜不该搜不到）。

### IR 编译默认走本地，`--remote` 留给排查与对拍（move-text-ir-compiler-to-client）

`gtrk mg compile` 此前每次都要打一趟服务端。现在 L0 编译在本地跑完：**零请求、零延迟、断网可用**。
TS 编译器是 Python 正本的第二实现，靠一道**逐字节等价闸**钉住（全量金样两侧逐字节相同，
本版 103/103）。

⚠️ `--remote` **MUST NOT 下线**：它是等价闸的参照系，也是真机上排查「本地编出来的和服务端一样吗」
时手上唯一的另一条路。

### IR 词表 v0.2：八项新表达 + 片段引用槽位（add-text-ir-vocabulary-v02）

`mask` 收数组（多条并存）/ `feather` 收两元数组（不等量羽化）/ `animTarget:"inner"`（蒙版钉死、
内容在后面滚）/ `repeatText` / `charRoll`（逐字滚码落定）/ `sweep`（扫光）/ `shape.glow` /
`anim` 新增 `skx`·`sky`，外加 **`runs[].slot`**。

`runs[].slot` 修的是一个缺口：`brush-title` / `caption-emoji-arrow` / `caption-keyword` 三颗的文字
写在 `runs[].t` 字面量里，**此前没有任何字段能改**。现在它们的槽位回来了。

⚠️ **`blur` 通道判否，且这是有射程的口径**：`filter: blur()` 被补间驱动正是 `gtrk mg lint` 的
`c-filter-animated` 所指、r69 真渲实测 **+36.2%** 的最贵形态。往后任何要 `filter` 的通道
（`drop-shadow` / `saturate` …）一律先找零卷积等价物，真找不到再单独拍板。

### `gtrk tool mad`：技法点名 `--technique` 与目录检索 `--search`

一键剪 MAD 此前只能让它自己挑技法。现在可以点名，也可以先查目录看有哪些
（语义匹配仍留给 Agent，命令面只做目录检索）。

### 其他

- `gtrk mg lint`：内嵌 IR 的**两代载体都认**——换载体那次产物字节全变，只认新的会把线上已发的颗粒
  整批判成 `detached`。

## 1.2.3（2026-09-13）

> ℹ️ **本节是补写的**。1.2.3 当时发到了 npm 却没进更新日志（包里那份 CHANGELOG 顶到 1.2.2 为止）。
> 补写口径是**发布产物实证**、不是按提交时间猜：拉 `@gitruck/cli@1.2.3` 的 tarball 逐项 grep，
> 确认 `text-template` / `compileIrBody` / `--technique` **一个都不在**（同时 `pip` 42 处、
> `subtitle_line_split` 3 处命中，证明探针本身能响）——文字模板那批全部落在 1.2.4。

### `gtrk mg lint`：新增非致命哨兵 `x-soft-alpha`（fix-alpha-delivery-discipline）

颗粒里只要有**半透明面积**（`rgba`/`hsla` 半透明色、`#RRGGBBAA`、渐变到 `transparent`、
带 blur 的 `text-shadow`/`box-shadow`、静态 `opacity<1`），lint 会提醒一句。

**恒非致命、不要求改写**——半透明本身完全合法。它提醒的是交付纪律：剪映的 qtrle 交付依赖渲染管线
在编码前**预乘 alpha**（剪映按预乘合成，直通 alpha 的软边会塌成实心，2026-09-14 真机实证）。
所以**剪映路径的真机验收 MUST 用这颗颗粒本身验，MUST NOT 拿实心颗粒代验**——实心颗粒对预乘错配
结构性失明，验了也是白验。

⚠️ 颗粒与 CLI **MUST NOT 自行预乘**，那会双重压暗。预乘是渲染管线那一侧的事。

哨兵刻意**不认** GSAP 补间参数里的 `opacity:0`：淡入淡出的端点是 0/1，不是驻留的半透明面积。

契约 `gsap-emit-v1.md` 同批增补「Alpha 交付口径」一节，`gtrk-mg` 图纸补剪映预乘纪律。

## 1.2.2（2026-09-13）

### `gtrk subtitle lay` 云端拆行：`subtitle_type` 直传预设 id，PascalCase 映射表删除（link-subtitle-lay-cloud-line-split §6.2）

拆行接口 2026-09-06 生产实测只认 infra `SubtitleType` 枚举**值**（`Default` / `Outline` / `CinemaYellow` /
`ImmersiveBox` / `WideSpacing` / `DeepShadow` / `Boxed`），传 CLI 侧的预设 id `immersive_box` 会被拒「subtitle_type 未知」——
同一枚举在 infra 两个接口上口径不一致，当时由消费方顶着，CLI 里挂了一张 `CLOUD_SUBTITLE_TYPE_BY_PRESET` 映射表兜。

现在 infra 把写法归一收进零依赖轻模块 `subtitle_styles.canonical_subtitle_type_name`（`add-subtitle-line-split-api` §9），
两个口同源。**部署后生产实测**：`immersive_box` / `ImmersiveBox` / `cinema_yellow` / `cinemayellow` 四种写法均 200、
拆行结果逐条一致，未知值报 6016 且可选集以 snake_case 列出 ⇒ 映射表退化为恒等，按联动件收尾删除，
预设 id 原样上行。

对用户**零行为变化**：`subtitle lay` 传哪个预设、拆出来的行与上一版一字不差。
未知 id 仍原样透传交服务端裁决（**fail-open 口径不变**）。
⚠️ 这张表为什么拖到今天才删：删表直传 snake_case 的前提是服务端那个改动**已部署**——
部署前删，线上就直接退回 09-06 那个「`immersive_box` 被拒」的缺陷。部署后它只是冗余而非有害，所以不急。

本版无其他面向用户的改动（其余提交是 openspec 子模块指针推进）。

## 1.2.1（2026-09-13）

### `gtrk tool video_purify` / `image_purify`：region 作用域——按框直接去除，视频可限定时间段（link-add-purify-region-scope-cli）

此前去水印只能「让服务端自己找」：`full_screen` 全片扫、`subtitle` 扫字幕带、`custom` 在归一化 ROI 里找水印。
用户明明知道要去的东西在哪一块、在哪几秒，却没法直说。新增 **`region` 作用域**——框内**全部内容**直接去除，不做识别：

```bash
gtrk tool video_purify <视频> --purify-scope region --purify-region 0.7,0.02,0.28,0.1 --purify-region 0.1,0.8,0.3,0.12,12,48
gtrk tool image_purify <图片> --purify-scope region --purify-region 0.7,0.02,0.28,0.1
```

`--purify-region` **可重复**，单次最多 16 个框（与服务端 `purify_roi.MAX_PURIFY_REGIONS` 同值）。
视频的框是 `x,y,w,h[,start[,end]]`——空间四元归一化，时间两元为秒，`end` 省略即到结尾，
**同一条片子里不同时间段的不同水印可以一次交清**。图片的框只有 `x,y,w,h`。
`image_purify` 由此**第一次有了选项**（`--purify-scope full_screen|region`）。

**组合矛盾一律前置报错**，不让用户上传完再被服务端拒：非 `region` 作用域给了 `--purify-region`、
`region` 作用域一个框都没给、框数超上限、图片的框带了 `start` / `end`（服务端会忽略它们，CLI 让你当场知道没生效）。
`params-json.regions` 通路照旧：只走 params-json 时只校验不改写，由 runner 的 `mergeParams` 合入（与 `custom` 的 roi 同款）。

两个工具**共引同一个选项对象**（注册器按完整 flag 串去重、先注册者的 desc 生效），
`validateRegistry` 新增一道闸拦同名选项写法不一致；`ToolOption` 加 `repeatable` 语义，注册时挂收集器、**缺省是空数组而非 undefined**。
⚠️ 本条依赖服务端 `add-purify-region-scope` 已部署。

### `gtrk matrix describe`：缓存键并入服务端判据版本，判据一改旧产物不再蒙混过关（fix-describe-window-coverage §10）

`describes` 缓存的 `usable_flags` 四维是**服务端判据**的产物。判据一改（把取景器 HUD 纳入 `text_overlay` 正例、
把被拍物体上的印字排除出 `watermark`），同一帧的正确读数就变了——而缓存键里没有判据版本的话，
旧口径条目**永不重跑**，用户读到的还是旧判据的产物，且完全无感。

现在缓存键实际是 `(material_id, ts_ms, criteria_version)`：新列**不进主键，而是读时比对**——
行还在、版本对不上就算未命中，下一轮按正常路径重跑。**旧行不删不改、仍可读**，
它是「用户上一轮看到过什么」的唯一凭据。写入侧改条件 upsert：版本相同维持原 `OR IGNORE` 语义
（换准则不许改写客观层，防 VLM 措辞漂移悄悄改掉下游在读的 `desc`）；版本不同才整行刷新，
否则新判据的 flags 永远落不进来、每轮重复计费还读到旧值。既有库幂等 ALTER 补列，旧行为 `NULL`、同走旧口径路。

**报数分栏**：`--json` 新增 `cached_stale_criteria`，是 `called` 的**子集**而不是额外开销，
专门回答「上轮明明理解过、这轮怎么又扣」——这些帧的旧产物出自更早的判据版本，不再作数。
首值 `overlay-enum@2026-09-12`，对应 infra `link-describe-overlay-flag-recall` 当日上线的判据枚举化（叠加物两维扩枚举 + 按维分级）。
⚠️ bump 的代价是真金白银：旧口径帧下一轮会重新调用、重新计费。这是有意的——判据变了还端旧产物，比多花一次钱坏得多。
服务端判据上线与本常量 bump **MUST 同批发版**。

### 文档：路径含英文逗号、零枚举硬失败、高潮点锚定口径（fix-material-intake-path-and-enumeration §5.2–5.4 等）

- **路径含英文半角逗号**就重复传 `--dirs`，**累加不覆盖**；整串在盘上存在时自动不拆，全角「，」从不参与拆分。
  `index` 报 0/0 先看这一条，再去查断链——README 中英与 `gtrk-matrix` 图纸排障表各补一行。
- **零枚举是硬失败**：`gtrk matrix index && describe` 串里，零枚举会真的拦住 `describe`（个别素材失败不算硬失败）；
  `index ... &` 后台起会把硬失败吞掉，回头要看 `materials.total` / `per_dir`——写进 `gtrk-travel-recap` / `gtrk-narration` 两份图纸。
- README 中英与四张旗舰图纸改写**高潮点锚定**口径。

## 1.2.0（2026-09-11）

### `gtrk pip lay`：屏幕一条 + 人像一条同步录的口播，一句话合成画中画（add-pip-companion-lay）

讲软件 / 讲课件 / 讲代码的口播多是**两条文件同步录**：屏录一条、人像一条。此前流水线只能剪其中一条——
`gtrk oralcut` 粗剪的每个切点没法落到另一条上，画中画只能去客户端手工摆，圆角与蒙版只有客户端看得见。
镜像切点是纯算术（每颗 clip 一个偏移），却是「每片必做、手工必错」的事，现在做成命令：

```bash
gtrk pip lay --project <口播工程目录> --companion <屏录.mp4> [--shape ellipse|rectangle|heart|diamond|star|none] [--feather 10] [--corner-radius 0.25] [--border-radius <px>] [--anchor bottom-right] [--scale 0.28] [--margin 40] [--offset <秒>] [--dry-run] [--expected-revision <sha256>] [--json]
gtrk pip lay --resume <屏录名>_pip_align.gtrk
```

**测偏移三分支，与 `gtrk audio align` 同一套原语**：缺省互相关自动对齐（人像为参考、屏录为待对齐）；
置信度不足 ⇒ 产 `<屏录名>_pip_align.gtrk`（人像整段 + 屏录整段按估测偏移摆好），用户在客户端把「伴随源」轨拖齐保存后 `--resume` 读回偏移再铺；
`--offset <秒>` 显式给值跳过检测。偏移口径全库统一：**正 = 屏录晚开录**。
⚠️ 屏录 **MUST 带麦克风音轨**才能自动对齐（互相关没有参照就没法算），只有系统音的屏录只剩后两条路——开工时就要提醒用户；
本命令与 `audio align` 一样只做**恒定偏移**，两台设备采样钟差导致的长片渐飘不矫正。

**镜像切点**：主轨每颗非空档 clip 的 `track_st / duration` 原样落到屏录轨，`clip_st′ = clip_st − offset`，整毫秒域、不累加游标；
越过屏录素材上界 / 下界的部分**钳位 + 留空 + 回执逐颗点名毫秒数**，MUST NOT 拉伸或变速——
屏录比人像短 / 晚开录的那几段成片只见人像主轨，如实告诉用户。

**铺两条轨，主轨与音轨一字不动**：屏录满幅轨（`track_index` = 现存视频轨最大值 + 1，静音）+ 人像画中画副本轨（再 + 1，静音，
带 `clip_transform` / `border_radius` / `clip_mask`）。人声仍由主轨镜像音轨承担，副本轨 MUST NOT 双声；
主轨不动 ⇒ 下游 `split` / `subtitle lay` / `mg` 照旧按 main 对 transcript，零感知。
形状缺省 `ellipse` = 以画中画短边内切的正圆；`rectangle` 满幅可带 `--corner-radius`；`heart` / `diamond` / `star` 短边内切；`none` 只摆位不遮。
`--scale` 的语义是**画中画显示高度占画布高度的比例**（缺省 0.28），写进 `clip_transform` 时按 contain-fit 反算。

**幂等 + 不覆盖用户改动**：改参数直接重跑，自产 clip（`producer = gtrk:pip@1`）先剥后铺、空轨删除；
用户在客户端动过、被清掉身份的画中画 clip **保留并在回执 `strip.keptForeign` 点名**（与 `matrix lay` 同一条认领纪律）。
写方自检（恒等式 / 接缝 / 素材上界）破了即抛零副作用；原子写回 + revision 断言，`--expected-revision` 跨命令拒写口径同 `gtrk patch`；`--dry-run` 只算不写。
回执打印的是**数字**（每颗的偏移 / 钳位 / 留空毫秒），不是一句「已验证」。

链路位置：`oralcut` 检查点① → **`pip lay`** → 拆分 / 字幕 → 出片，**不新增必停点**，铺完让用户在客户端看一眼即可；
口播图纸（`gtrk-talking-head`）开工五问加第 ⑥ 问（有没有同步录的屏录或第二机位、画中画形状 / 位置 / 大小），屏录题材默认不铺 B-roll。
出片三口：客户端本地导出 / `gtrk render`（见下一节）/ 导剪映（`diamond` 剪映无对应，跳过并明示）。
纯本地**零计费**，素材不上行。一条伴随源起步，多机位切人另立。
⚠️ 客户端预览里看到画中画的圆角与形状蒙版，要等客户端同步更新（消费这两个契约字段的那一半随客户端发版）。

### `gtrk render`：画中画的缩放 / 落位 / 旋转 / 透明、圆角与五形状蒙版随工程本地合成（link-clip-mask-contract-render）

1.1.10 把叠加层渲进了成片，但每一层的**几何**还没读：叠加输入一律 contain-fit 后贴满画布，
客户端里摆好的画中画渲出来是**满幅信箱**，圆角与蒙版更是零支持。现在按契约逐 clip 消费：

- **`clip_transform`**：`scale_x/y` 在 contain-fit 之后再乘（与客户端「先 contain 再乘 scale」同口径，负值 = 翻转）；
  `position_x/y` 以画布中心为原点落位；`rotation` 旋转（落点按旋转后包围盒算）；`alpha` 透明。
- **`border_radius`**（画布像素）与 **`clip_mask`** 五形状（`rectangle` + `corner_radius` / `ellipse` / `heart` / `diamond` / `star`，与契约枚举一字不差）：
  支持 `invert` 反相、蒙版自身 `rotation`、`feather` 羽化（0..100 = 占蒙版短边百分比）；两者同时在场**叠乘**（元素圆角 ∩ 形状窗），不降级。
- 颗粒（`beat_track`）不动：契约不给颗粒这两个字段，颗粒尺寸由 HTML 自带。

**不引图形库**：五形状 + 圆角 + 反相 + 旋转都是闭合路径填充，用纯 JS 扫描线光栅成一张 8-bit 灰度 PNG（node 内置 `zlib` 编码，**零新依赖**——
多一个原生依赖就多一条安装故障面），ffmpeg 只负责 `gblur`（羽化）+ `alphamerge` + `overlay`。确定性、离线、**零计费**。
蒙版纹理按参数 + 尺寸内容寻址落 `<工程目录>/.tonghe-cache/masks/<sha256>.png`，可复用、丢了重生；
缓存目录不可写退系统临时目录，两处都写不了才放弃该纹理——此时该 clip **只按几何叠加并明示**（`maskSkipped`），MUST NOT 阻断渲染。

**零回归门**：`clip_transform` 缺席或恒等、且无圆角 / 蒙版的 clip，滤镜链与 1.1.10 **逐字节相同**，既有黄金向量原样通过。
`--json` 的 `overlay` 段新增 `transformed` / `masked` / `maskSkipped` 三个计数，完成话术逐类点名
「几段按 clip_transform 落位 / 几段合成了蒙版或圆角 / 几段纹理不可用只按几何叠加」。
两条口径：羽化是高斯近似，与客户端的距离场羽化**观感等价、不逐像素等价**；
客户端专有蒙版形态（钢笔 / 文字 / 分屏 / 黑边 / 描边 / 多蒙版）只在客户端状态里，本地渲染不读。

### `gtrk oralcut --lang`：按识别源语种分档校验，切点线不支持的码在抽取前就拒（link-enum-catalog-cli §7）

1.1.10 的枚举清单把 `--lang` 改成按快照校验，但拿的是 `subtitle.languages`——那是翻译目标语与识别源语种的 **11 项共同范围**，
会放行 `es-ES` / `pt-PT` / `ru-RU` / `vi-VN`，让用户抽完音频、传完文件，才被服务端 6015 拒。
现在 `/catalog` 下发 `subtitle.source_languages`，**按 task_type 分档**（切点三线 7 项：`en-US` / `fr-FR` / `ja-JP` / `ko-KR` / `zh-CHS` / `zh-CHT` / `zh-CN`；
`video_ai_subtitle` / `subtitle_translate` 11 项），`oralcut --lang` 改按 `video_oral_cut` 那一档在**抽取之前**校验，报错只列本线 7 项。
退回规则不破 1.1.10 的两条既定口径：分档整体缺失（老服务端 / 旧快照）/ 缺该线 / 形态不合 ⇒ 退回 11 项共同范围；
共同范围也拿不到或无快照 ⇒ 放行交服务端裁决——**fail-open、只降不升**。
`long2short --language` / `transcript --lang` / `gtrk tool` 的翻译语种参数本来就不做本地取值校验，这次一格不动。

## 1.1.10（2026-09-10）

### `gtrk render` 现在会把 MG 颗粒与 overlay 真的渲进成片（add-render-overlay-compositing）

此前本地渲染的视频侧**只投影一条主轨**：铺了 65 颗 MG 颗粒、铺了整轨 B-roll 候选，渲出来一个都没有，
而且退出码 0、渲后质检一切正常——**缺件成品，却一声不吭**。
现在按契约 z 序（`track_index` **升序**，越大越靠前）把**全部可见叠加层**叠进成片：
overlay 视频轨（B-roll 候选 / AI 再现回铺）与 `beat_track` 的 MG 颗粒都在内。
在客户端关了「小眼睛」的轨（`hidden`）整条不进片；多条候选轨都可见时成片取最上层（= 客户端预览所见）——
渲染器**只读字段不猜**，与音频侧「只认 `muted`」是同一条纪律。

颗粒那一段有计费：CLI 没有 HTML 渲染引擎，颗粒送同合云烤成 qtrle 透明 MOV 再本地叠。
计量 = **唯一颗粒数 × 未命中缓存数**（按分钟），未命中时先出预估并要确认（`--yes` 跳过；
`--json` 下必须显式 `--yes`，否则硬拒——机读模式没有 stdin，不静默提交计费任务）。
缓存落 `<工程目录>/.tonghe-cache/particles/`，**与客户端导出剪映那条链同键同落点** ⇒
任一端烤过，另一端直接命中：**第二次渲染零计费**，客户端烤过的工程 CLI 首渲即零计费。
不想花钱用 `--no-particles` 出无颗粒版（overlay 视频轨照常合成，那部分零计费、纯本地）；
`--particle-concurrency <n>`（1–8，默认 6）调并发。

三条如实告知：跳过的颗粒、隐藏未叠的轨、缺素材未叠的 clip 都在人读日志与 `--json`
（`particles` / `overlay` 两个新字段）里逐类点名。overlay 素材本地缺失**只降级不阻断**——
B-roll 代理没下全，不该让一条 45 分钟的片子出不来。
无叠加层的工程**滤镜图逐字节不变**（零回归门有黄金向量守）。
⚠️ 顺带一条口径更正：`gtrk render` 不再是纯本地零计费命令——工程有未命中缓存的颗粒时，
**颗粒 HTML 文本会上行**（素材本体仍不上行），此时会打一次合规告知。

### 本地渲染的 clip 上限 500 → 2000：长口播不再被一个「借来的」阈值挡在门外（adjust-local-render-clip-ceiling）

45 分钟口播经 `gtrk oralcut` 逐停顿切出 **593 个 clip**，本地渲染直接报「clip 总数 593 超过上限 500」——
按 13 clip/分钟折算，这等于给本地渲染判了「口播不得超过约 38 分钟」，而这个限制**从来没有被当成产品决策做出过**：
500 是**镜像后端**的常量，那边的语境是云端多租户资源保护（防单任务吃掉渲染机）。
本地渲染没有多租户、输入还按路径去重（593 clip / 1 素材 = 1 个 `-i`），代价只是本机自己变慢、由本机用户自己承担。

新值 **2000 由实测裁定**，不是「翻个倍听起来合理」——本机实测 ffmpeg 构建滤镜图的成本：

| clip 数 | 初始化墙钟 | 峰值内存 |
|---|---|---|
| 500 | 1.25 s | 151 MB |
| 1000 | 5.2 s | 264 MB |
| **2000** | **20.3 s** | **476 MB** |
| 5000 | 167.9 s | 1138 MB |

时间近 **O(N²)**、内存线性（约 0.23 MB/clip），而且这只是**开渲之前**的等待。
所以一度考虑的 5000 被自己的实测否掉（干等 2.8 分钟 + 1.1 GB）；2000 ≈ 2.5 小时口播，覆盖已知全部形态。

配套两条：**超限话术**改成说清三件事（这是**本机**的闸、不是云端限制 / 当前多少 / 出路是拆工程或来提 issue）；
clip 数 **超过 1000** 时先打一行 INFO 说明「构建滤镜图要花点时间，不是卡死」——
那段没有任何输出，最容易被读成卡住。告知档是**绝对值**不是「上限的百分比」（相对量说不出用户要等多久）。
叠加元素（overlay clip / 颗粒）**不计入**这个计数，闸值与计数口径一次只动一个。

### `gtrk mg fetch`：registry 中性颗粒源，不会做动画也能拿到能用的颗粒（add-mg-registry-neutral-source）

MG 车道此前只有一条路——你自己的栏目 MG 生产 skill 从零写 GSAP 颗粒。没有那套资产的人，`dispatch.mg` 就是空的。
现在随包带一份 **Hyperframes registry 快照**（`src/data/mg-registry-catalog.json`，180 件，
钉死来源 `heygen-com/hyperframes@8bf5b44`，快照日 2026-09-10）：`gtrk mg fetch` 不给 `--pick` 是**候选态**（只列不取，**离线可用**），
给了才取块——取块三源按序试：**我方镜像（大陆可达）→ jsdelivr → GitHub raw**，每源 5 秒超时，
任一源返回的字节 **MUST 过 sha256 与快照比对**（版本错位 / 篡改在这一步被拒）。
`GITRUCK_MG_REGISTRY_BASE` 可整体覆盖取块前缀（自建端点 / 内网），与运行时资产的 env 覆盖同形。
取回的块经**机械改写**成合规颗粒并过 `mg lint` 门：改画布 / 改透明底或满屏底 / 换字体（缺省取运行时镜像可证的 CJK 字体）/ 钉 composition_id。
两种用法：`--slot <beat>` **派单模式**（从 `dispatch.mg` 取 composition_id 与坑位包络，产物落 `<工程>/mg/`）、
`--id` + `--duration` **独立模式**。契约当前只收 1920×1080，其余画布明确拒绝。
**刻意不引 hyperframes CLI**：端点是静态文件，Node 内置 fetch 够用——省掉用户侧 33 MB + 原生二进制 + Node ≥22 的负担。

### `gtrk skills recommend` / `gtrk skills add`：第三方 skill 随包推荐目录（add-third-party-skill-catalog）

我们的图纸只覆盖成片编排，视觉玩法（钩子 / 动态图讲解 / 动态字幕 / 数据可视化 / 地图 / AI 再现 / 拼贴 / 字幕 / 设计原则）
一直是「你自己去找」。现在随包带一份**第三方 skill 推荐目录**（快照 2026-09-10，九个场景），
`gtrk skills recommend` 无参列场景枚举、`--scene <id>` 按 tier（T1 在前）列条目，`gtrk skills add <repo>` 直接装。
人读输出**恒走 stderr**，`--json` 时 stdout 只有 JSON。
星数是**快照值**，回执明写「以仓库页为准」——目录随包发版，不联网校核，不假装是实时数据。
公约正本同批立 §三‴「第三方 skill 推荐面：**三档、克制、不点名**」，六份成片图纸 SKILL.md 按它接推荐面：
图纸先给自持方案，再轻提一句「要更多变体可以看第三方 skill」，**不在正文点名具体仓库**——点名要靠 `recommend` 命令去查。

### 成片型图纸公约加一节「前六秒：钩子层」（add-blueprint-opening-hook-layer）

公约正本（`docs/成片型图纸公约.md`）新增 §三⁗：前六秒决定完播，而外部钩子 skill 全是纯文本、不知道我方四车道，
所以「钩子文案 + 前六秒画面 + 字卡节奏」三合一**由图纸自持**。
口播链 / 配音链同批落执行文本：**检查点①之前**由 agent 产一份「前六秒方案」——
钩子文案三候选（只改开口方式，**MUST NOT 改动用户的事实与数据**）+ 画面层三选一（A_ROLL / MG 字卡 / 拼贴或 AI 片段）+ 字卡节奏，
**与其他拍板项同屏一次拍板**，MUST NOT 单独追问、MUST NOT 在检查点①之后再冒出来。
答「开场照原样」= 零动作、后续不再提。

### 首跑与 `gtrk init` 收尾补一句交接指路（add-agent-handoff-signpost）

新用户跑完 `gtrk init` 常以为下一步该去客户端里跟 AI 对话。首跑块与 `init` 收尾各补一句明示：
**客户端目前没有 AI 对话框，对话在 Agent 里进行**，客户端负责精修与出片。

### 枚举清单：校验取值改由服务端下发，服务端加一种样式不用等 CLI 发版（link-enum-catalog-cli）

此前 `--subtitle-type` / `--subtitle-color` 的可选值被**抄在 CLI 本地常量**里：服务端新增一种字幕样式，CLI 会当场拒掉那个**合法值**；服务端临时下架一个能力，CLI 还在往外发。两种都不报错，只是行为不对。
现在启动云端命令时向 `GET /catalog`（公开只读口）拉一份枚举清单，落 `~/.gitruck/catalog.json`：新鲜期 24 h 内**零网络**，过期走条件请求（304 只推进时刻、200 整体替换），拉不到就沿用旧快照并打**一行**降级提示。
`--subtitle-type` / `--subtitle-color` / `gtrk oralcut` 的 `--lang` / `--preset` / `--formats` 都改按快照在**上传之前**校验并列出可用集；`gtrk tool list` 与直调按服务端下架名单标「暂停服务」并拒绝提交（**只降不升、且只在快照新鲜时生效**）。
`gtrk doctor` 新增「枚举清单」行（版本 / 拉取时间 / 落点）与 `--refresh-catalog`。
三条硬性质：① **拉不到 MUST NOT 让命令失败**——任何失败分支都放行，交服务端白名单裁决；② **`--help` 路径零网络**（注册期只读快照文件，有真进程 fetch 计数守卫）；③ 服务端白名单**恒为唯一真相源**，本地校验只是「早点告诉用户」，所以无快照是放行而不是拒绝。
本地清单有可能比服务端旧 ⇒ 报错文案一并告知逃生口：`--refresh-catalog` 立刻刷新，`--param` 绕过本地校验。与 infra `add-enum-catalog-api` 联动（该端点 2026-09-10 已上生产）。

## 1.1.9（2026-09-10）

### CLI 崩溃自动上报：崩了不再只留一句红字（link-client-error-report-cli）

CLI 崩溃时**只上传错误消息与堆栈**到同合云 `POST /error/report`，不带素材、工程内容与凭据。
四路收口：`uncaughtException` / `unhandledRejection` / 顶层命令异常 / 已知崩溃形态；
同一进程内的连环崩溃按「名字 + 首帧」压成一条并累加 `occurrence_count`，不刷屏也不刷库。
首次运行打一行告知，关闭方式两种：`gtrk init --no-crash-report`，或设 `GITRUCK_CRASH_REPORT=0`；
`gtrk doctor` 新增「崩溃自动上报」行显示当前开关状态。上报前做凭据洗白与长度截断。
与 infra 主件 `add-client-error-report`、客户端半 `link-client-error-report-client` 同线。

### 长剪短：分屏开不开由开工一问决定，clips.md 回显分屏请求态

（补记）分屏不再默认硬开：开工时先问一句「是否多人同框」，据此决定本次是否请求分屏；
`clips.md` 回显本次的分屏请求态，避免「以为开了其实没开 / 以为没开其实开了」。

### 倍帧素材的假切点：切点判定改在去重帧序列上进行

（补记）倍帧（同一画面重复多帧）素材此前会在重复帧之间判出并不存在的切点，
现在切点判定改在**去重后的帧序列**上进行。

---

## 1.1.8（bump 了但没发）

`package.json` 从 1.1.7 bump 到 1.1.8（`2f20453`），但**这一版从未推上 npm** ——
registry 上 1.1.7 之后直接是 1.1.9。留此条只为解释版本号为什么跳，无内容变更。

---

## 1.1.7（2026-09-09）

### `gtrk` 装完即可敲：install 自持全局副本 + Windows 用户级 PATH + doctor「命令可达」+ upgrade 沿自己的通道升级（add-gtrk-command-availability）

此前 `npx @gitruck/cli@latest install`（官网默认路线、全套 `install.ps1` 第三步）只装 skill 与配置，**从不安装 gtrk 本体**——npx 跑完把包丢掉，新开终端敲 `gtrk` 不是命令；`npm i -g` 路线则要靠 npm 全局目录恰好在 PATH 上。
现在 `gtrk install` 先做第 ⓪ 步：运行中的自己若不是持久 PATH 能解析到的那份（npx 临时态 / 未 link 的本地检出），先 `npm i -g @gitruck/cli@<运行中版本>` 自持（钉运行版、已有更高版本不动）；随后按**持久** PATH（Windows 读注册表 HKLM+HKCU，不是启动它的终端给的 PATH）核对启动器目录，不在就追加到 HKCU 用户 PATH **尾部**（保留 `REG_EXPAND_SZ`、原值 `%…%` 不展开、不去重不重排、幂等）并广播 `WM_SETTINGCHANGE`；写被拒只给可读原因与手工指引、不让 install 退非零。macOS/Linux 不改任何 rc 文件，不可达时打一行 `export PATH=…`。
`gtrk doctor` 新增「命令可达」行：持久 PATH 解析到且版本一致为绿，解析不到为红并指向 `gtrk install`，敲到另一版为黄。`gtrk upgrade` 按 `process.execPath` 是否在 `~/.gitruck/node/` 之下判定通道：私有运行时（桌面端自举落位）用私有 node + 私有 npm + `--prefix ~/.gitruck/npm` 升级并复核启动器，**不去找系统 npm**；npm 全局通道维持现状。
规格：新立 `gtrk-command-availability`；`ffmpeg-runtime` 的「用户环境零侵入」条款收窄射程为 ffmpeg/字体等运行时资产（gtrk 自身启动器目录进用户 PATH 是明确例外）；`gitruck-home` 登记 `node/` `npm/` `bin/` 三目录（客户端自举的私有运行时布局）。与 opencut 仓 `add-cli-bootstrap-runtime` 联动：本版先发，客户端再发。

### 封面工作台：T1 字体读用户本机、描边缺省 0（add-cover-workbench-font-switcher）

`gtrk-cover` 排字工作台右栏新增「字体」下拉与「字重」档位（400 / 700 / 900）：下拉首项恒为 skill 注入的当期默认字（`T1_DEFAULT_FONT`，仍是 skill 按栏目封面风格资产或中性默认做的审美决策），
其余项来自**用户本机已装字体**，三级取数、任一级成功即可用——打开即按内置候选表（约 70 款常见中文字体，中英文名两写法）做 canvas `measureText` 已安装探测；Chrome / Edge 点「读取本机字体」经 Local Font Access API 取全量（需授权一次，结果与探测结果取并集、当前选中项恒保留，接口返回空按失败退化并解释）；
两条都没列出的在输入框敲 family 名回车应用。三级全失败不阻塞。导出走本机 `html2canvas`，本机字体天然可用；与 MG 颗粒「字体名 MUST 命中服务端注册表」是两条线，guide §10 已写明分界。
T1 描边缺省由 2 改 0：思源黑 / 宋这类重叠轮廓的特黑字体加 `text-stroke` 会把部件内部轮廓描成镂空积木（缩略预览看不出、导出才炸），托底改用暗色双层 `text-shadow`，滑杆保留。
引擎层（拖拽 / 方向键 / 滚轮 / 导出 / 舞台缩放）零改动。同批：SKILL.md 铁律 3 暴露面加「T1 字体与字重档位」、中性默认「描边不加」，checklist ⑥ 补描边与切字体后可读性。

---

## 1.1.6（2026-09-08）

### 产物落点硬闸：计费前先实证落点可写，缺 `--out` 当场硬拒

（补记）`gtrk oralcut` / `gtrk mg` 在**上传与计费之前**先实证产物目录真的写得进去，
写不进就阻塞拉用户处理到可写为止（非交互当场硬失败），**不静默改投别的目录**；
缺 `--out` 不再猜一个落点而是当场硬拒；MG 颗粒必须产在工程目录内。

---

## 1.1.5（2026-09-07）

### 锚点金样入册（fix-anchor-top-hit-guarantee §5）：决策 pin v5 的金样清单 53 → 57、哈希重登记不升 v6

`test/fixtures/broll-arrange/cases/` 新增 `44-anchor-sim-order-real-q1`（真机复刻 Q1/B04 两刀合璧：锚槽按原始 sim 取校门段而非融合分顶上来的广告牌，B02 泛化槽让位转次优）/
`45-anchor-cross-beat-reserve-lay2`（备选轨同受预留约束 + 不相交 beat 零回归）/ `46-anchor-reserve-release`（逐锚 finally 与零长度 beat 早退两条释放路）/
`47-anchor-vs-anchor-at-sec-order`（at_sec 先到先得、`reserved` 与 `consumed`+`top_by` 两种归因形态），均由 `regenerate.mjs` 产出，临时变异实证各自在「锚序退回融合分 / 关掉预留」下 expected 会变。
决策层零改动（`matrix-lay.ts` 零 diff），既有 53 项金样逐字节不变、`cloud-form.json` 逐字节不变、`metering.json` 只多 4 条派生 entry（`METERING_ALGO_PIN` 不动）。
v5 尚未发版 ⇒ `PIN_TO_MANIFEST_SHA[v5]` 由 `3bcc7aef…` 重登记为 `cc82e20e…`（57 项）而不升 v6，infra `link-anchor-top-hit-guarantee` 同批把 `_PIN_TO_MANIFEST_SHA[v5]` 改成同一个数。

### gap 填充：恰等 1ms 的残量并入前一颗、合并容差统一到整毫秒格（决策 pin v5）

`matrix lay` 主轨 gap 填充的合并容差从秒域浮点 `BLACK_BED_MERGE_EPS = 0.001` 改为整毫秒格具名常量 `BLACK_BED_MERGE_TOL_MS = 1`（`sec2ms` 整数差比较）。
此前同一行 `x > 0.001` 在不同时间线位置上因浮点相位给出两种答案（0–300s 毫秒格上 `r3(t + 0.001) − r3(t)` 65.08% 的位置 `> 1e-3`、34.92% 的位置 `≤ 1e-3`），
真机三条片里恰等 1ms 的残洞一处排出 0.001s 黑片、一处留 0.001s 裸缝。现在恰等 1ms 的残量恒判「有量」、恒进既有 ②a / ②a′ 延长链由前一颗吸收
（前一颗 `track_ed` 与源窗终点同延 1ms、`track_st` 不动、`kind: "extend"`，不新增分支不新增 kind；源窗为此越出检索段界 ≤ 1ms 是具名例外，既有 `MICRO_SLOP` 松弛档覆盖）。
同批改整毫秒格的判据（A 档）：`beatGaps` / `computeBlackBedHoles` / `mergeBlackBedSegments`、`fastFillBeatGaps` 全部容差消费点、高档直排的落位重叠与越 beat、碎尾吸收、锚槽 room、段界包含
（52 份金样 + 3 份真机 plan 的 2182 段段界实测全在毫秒格上，逐值同解）。只改名不改值（B 档）：`CUT_ALIGN_EPS → CUT_ALIGN_WINDOW_SEC`（业务阈值 0.1s）。
明确不改（C 档，登记转出）：吸附率比例 `1e-9`、`refineWindow` 帧号域与秒域 ε、`1/fps` 亏空、句界吸附带。
「主轨零 gap」不再无条件打印：由整毫秒格对填充后主轨产物（含 solid 与 gap 填充槽位）的实扫得出，仍有 ≥ 1ms 缝即如实报数并 WARN；
lay JSON `gap_fill` 新增**条件键** `residual_gaps { count, sec, items[] }`（零缝整键缺席）。
决策产物字节：既有 52 项金样逐字节不变，新增 `cases/43-gapfill-eps-exact-residue`（同一 1ms 残量两相位同解）⇒ `LOCAL_DECISION_ALGO_PIN` v4 → v5、金样清单 52 → 53
（`PIN_TO_MANIFEST_SHA[v5] = 3bcc7aef…`，infra `link-gapfill-eps-boundary-residue` 同批镜像、逐字相同；`METERING_ALGO_PIN` 不动，metering.json 只多一条派生 entry）。
**发版序**：infra `add-arrange-decision-pin-echo` 回传先上线 → infra 决策层 v5 上线 → 本包发版；顺序错则 ≥ 1.1.3 客户端在读到 `server_ahead` 之前整轮退回自校验、
`self_check_failed` 回落本地并白付一次编排费（服务端不按决策 pin 拒绝客户端；真会前置拒绝的是 `METERING_ALGO_PIN`）。

### 时间消费侧统一：`gtrk render` 接缝判据与 `gtrk patch` 校验器同源（整毫秒格）、匿名 ε 清退、`qc` 阈值具名

`gtrk render` 的同轨重叠 / 缝 / 尾补判据从 `±1e-6` 浮点秒改为**整毫秒格**（`sec2ms`），与 `gtrk patch` 的 E9 `same_track_overlap` 同一判据：
`sec2ms(track_st)` 小于前一元素终点即拒渲、大于即补 gap、相等即相邻。**`render` 变严的一面**：重叠 ≥ 0.5ms 的工程拒渲，话术含修复指引
（用 `gtrk patch` 校验并修正该轨，或用客户端打开工程重存一次后再渲染）；此前 render 收而 patch 拒的「一收一拒」不再存在。
**变宽的一面**（只影响时码不在毫秒格上的老工程 / 客户端按帧写出的工程）：亚毫秒（< 0.5ms）重叠视为相邻不再拒渲，亚毫秒缝不再插一个 0 帧黑场元素；
gap / 尾补时长落在整毫秒格上（`atrim=end=` 一类字面从 `276.366667` 变 `276.367000`）。三位小数工程的 filter_complex 逐字节不变；
`allocateFrames` 累计量改整毫秒和、帧化经 `sec2frame`，真机工程副本（客户端按帧写出，110 元素）裁定帧数与改前相同（8291 帧）。
`caption-align` 三种时间比较（同句回缝 gap / 字级去重 / 行推进与小 gap 桥接）统一到具名 `CAPTION_TIME_GRID_MS = 1`，`EPS = 1e-6` 与裸 `1e-3` 清退
（亚毫秒差的重复字现在会去重、亚毫秒缝不再算一次桥接）；`audio align` 的 `adelay` 分流阈从 `0.0005s` 改整毫秒（不足 1ms 的偏移即零偏移）。
全仓 32 处内联换算收编为 `frame-domain` 的 `r3`（15 处）/ `sec2ms`（15 处）/ `sec2frame`（2 处），逐值同；`matrix lay` 代理帧率不等判据改用
`VFR_MISMATCH_RATIO`（相对差 1%，此前本地 `PROXY_FPS_EPS` 按绝对差 0.01 比、与其头注「1% 以内」不符）。
`qc`：`cutMatchTolSec` 改名 `cutMatchWindowSec`（未经 `--json` 暴露，无别名），`cutMaxDriftSec / slotLookupSec / knownBlackHoleMatchSec` 进
`QC_THRESHOLDS`（值不变），`av_drift` 项新增 `frames: {probed, expected}` 佐证（成片 `nb_frames` vs `sec2frame(工程时间线终点或音频时长, video_rate)`，判级不变）。
决策层（`matrix lay` 的 `refineWindow / fillSlots / layAnchored / planBeatFills / slotTimes` 与 gap 填充）零改动，铺轨金样与 `MANIFEST` 逐字节不变。

### 标准帧率表与 VFR 可见；`gtrk render` 对非整数 `video_rate` 从静默渲染改为报错（含修复指引）

`frame-domain.ts` 新增本仓唯一的标准帧率表 `STANDARD_RATES`（`24000/1001, 24, 25, 30000/1001, 30, 50, 60000/1001, 60, 120`）与两个视图：
`snapRationalRate`（源真值：与表中值相对差 ≤ 0.2% 才吸附，`29.970029 → 30000/1001`，非标值原样）、`deliveryRate`（交付整数：NLE 表
`[23.976, 24, 25, 29.97, 30, 50, 59.94, 60]` 最近邻后取整，与客户端同口径、封顶 60，`(0, ∞)` 无洞）。`audio align` 兜底工程的顶层与素材
`video_rate` 改经 `deliveryRate`（29.97 → 30、23.98 → 24 与此前同值；源片帧率解析不到时改为报错，不再静默写出 1fps 工程）。
`probeGeometry` 在同一次 ffprobe 里加读 `avg_frame_rate`，给出 `avgFps` 与三态 `vfr`（`|avg − r| / r > 1%`；容器无 avg 时 `null` 不判）；
判据阈值 `VFR_MISMATCH_RATIO` 一处定义，成片质检 `qc` 的 `vfr` 项改 import 同一常量（行为不变）。

**`gtrk render` 变严**：顶层 `video_rate` 缺席、非正或非整数（典型是老工程里的 29.97）此前会按 29.97 静默分配帧数并进 `fps=` 滤镜，
现在与 `matrix lay` / `gtrk patch` 同一条判据、同一条话术报错退出，且在解析 ffmpeg、探测素材、写临时滤镜文件**之前**即止（无产物、无残留）。
修复：用客户端打开该工程重存一次即吸附到标准帧率（29.97 → 30、23.976 → 24），或手工把顶层 `video_rate` 改成正整数；
`video_rate` 已是正整数的工程渲染结果与此前逐字节相同。

`oralcut` / `long2short` 上传前：源片判为 VFR 时 WARN 一行（名义 `r_frame_rate` 与平均 `avg_frame_rate` 两值）但不阻断，上行几何仍是
真实 `r_frame_rate`；`--json` 与 result.json 多一个 `source: { path, fps, avg_fps, vfr }`。源片帧率解析不到（`r_frame_rate = 0/0`）时
在上传前报错退出（零抽取、零上传、不留产物目录），不以 25 / 30 兜底。`matrix index` 入库：VFR 视频素材逐条 WARN、`--json` 多
`vfr_materials` 计数（不加索引列，检索透出的 `fps` 仍是名义值）；帧率解析不到的视频素材跳过不入库并 WARN（计入 `failed`）。
`ai-drama lay` 拷贝后探测顺带 VFR 告警。决策层的吸附网格、铺轨金样与 `.gtrk` 字段零改动。

### 跨时钟适配器：preview 代理落盘即实测、云端产物落地复核、写方自检覆盖音频轨

`matrix lay` 下载（或缓存命中）每颗 preview 代理后现场 ffprobe 一次，`materials[]` 条目的 `duration / video_size / video_rate`
改写**落盘文件本身**的实测值（此前写的是云端自述的原片时长与猜测尺寸）；云端自述只用于比对——时长差超一帧或帧率不等各打一条
WARN，全量明细进 `--json lay.clock`（`proxy_probed / unverified / proxy_mismatch[] / proxy_fps_mismatch[]`）；探测失败回退自述并计
`unverified`，不让铺轨失败。槽位选段与吸附网格不消费实测值（云本平价，决策与金样逐字节不变）。`ai-drama lay` 同款：拷贝后实测覆盖
工作台 manifest 的 `measuredSec`，差 > 1ms 告警并进 `--json clock.manifest_mismatch[]`。`subtitle lay` 云端拆行的兜底行时码钳进父句
包络（越出父句的行不再原样落轨），计数进 INFO 与 `--json clamped_lines`。`oralcut` / `long2short` 拉回 `.gtrk` 后以本地原片实测时长
为墙复核不变量，只 WARN + `--json landing_check`，产物一个字节不改、退出码不变。写方自检射程扩到 `audio_track`，`audio lay` 写回前自检
本次 BGM clip（存量违例只 WARN）。本地索引代理三档解码参数由单测锁定无任何时基滤镜。

### matrix lay 落轨在工程帧网格上（写出侧变换，决策与金样不变）；gtrk patch 的毫秒投影改向下

`matrix lay` 写出的每一颗 B-roll 槽位与黑底 clip，起止时码现在都是顶层 `video_rate` 帧网格上某个整帧号的投影
（与 `gtrk patch` 同一套 `sec2frame / f2ms`）。帧格化是**写出前的一次变换**：填槽 / 锚定 / gap 填充 / 源窗精修等
决策层仍以毫秒与实数游标工作，选段、切分位置（`clip_st`）与金样逐字节不变；写出时每颗槽位两端各取一次帧号
（端点挪动 ≤ 半帧 + 1ms），相邻槽位的接缝由同一个帧号构成，黑底按 beat 包络投影、与首槽起点天然封口。取整帧后
`clip_ed` 越过检索段界（或素材时长）时宁短一帧并让同轨后续槽位整体前移一帧（接缝仍相等），逐次 INFO 可见。
本地槽位与云端编排返回的槽位走同一入口。此前槽位只知道毫秒，真机 30fps 工程里 B-roll 轨 62 颗有 30 颗、黑底
10 颗全部离网格，客户端帧级缩放下「没有一条边对得上」，还有两处一帧黑闪与一处溢出一帧。
工程顶层缺 `video_rate`（或非正、非整数）时 `matrix lay` 直接报错退出、工程零改动，不再有毫秒路可退；
`--json` 的 `lay` 多一个 `frame_grid: { rate, slots, black_bed, shifted }` 诊断块；过短黑片账面的帧数按就近取整判
（网格上的一帧黑片如实进账）。

`gtrk patch` 的帧号 → 毫秒投影由就近改为**向下**（`f2ms`）：客户端合成器按「起点 ≤ t < 终点」采样，
就近投影会让 24 / 30 / 60fps 下三分之一的帧位晚一帧才在场；向下之后客户端与 `gtrk render` 对同一帧号
得到同一有效帧。可见变化：这些帧位上写出的 `track_st / track_ed` 比以前小 1ms，帧号不变，往返照旧可逆。

### ai-drama lay / mg lay 落轨帧格；投影终点规则

`ai-drama lay` 写出的每颗 AI clip 与 `mg lay` 写出的每颗 MG 颗粒，起止时码现在都是顶层 `video_rate` 帧网格上整帧号的投影
（与 `matrix lay` / `gtrk patch` 同一套换算、同一个向下方向）。`ai-drama lay` 的毫秒决策链（建议时长 / 剩余 / 末镜吃满 /
不足即跳）一字不改，帧号由累计位置一次取整，相邻镜的接缝由同一个帧号构成；取整帧后越过素材实测时长时宁短一帧、同包后续镜整体前移
一帧（逐次 INFO 可见），不足半帧的镜跳过。`mg lay` 对每颗颗粒的窗口两端各取一次帧号，同 beat 的主颗粒与 `-aux` 覆层同窗即同一对
帧号，`--only` 保留搬运的存量颗粒不重投影；拆分稿的 beat 毫秒包络本身不变。此前两者只知道毫秒，真机 60fps 工程里 21 颗 MG 颗粒
全部离网格，客户端向上帧化与 `html_animate_render` 就近帧化会在同一颗颗粒上差一帧。工程顶层缺 `video_rate`（或非正、非整数）
时两条命令直接报错退出、素材 / 颗粒不复制、工程零改动；`ai-drama lay --json` 多一个 `frame_grid: { rate, shifted, dropped }`。

`gtrk split` / `gtrk subtitle` 所依赖的时间线投影改为**起点取整一次、终点由时长导出**（`track_ed = track_st + r3(e − s)`），
不再两端各自取整；非整毫秒相位下终点与以前最多差 1ms，投影产物仍留在毫秒域、不吸帧。

### lay 命令写回前自检不变量

`matrix lay` / `mg lay` / `ai-drama lay` 在写回工程之前自检**本次写出的** clip：裁剪恒等式、同轨零重叠（含与既有邻居）、
`clip_ed` 不超素材实测时长（容差 1ms）；违约直接抛错点名 clip_id 与不变量，工程文件逐字节不写。工程里由旧客户端重存留下的
存量违例只打一条 WARN 汇总（kind 计数 + clip_id 样本 + 修复指引），不阻断本次写回。

### 字幕拆行改走云端，剪掉的字不再上屏

`gtrk subtitle lay` 的拆行不再在本地按字宽硬切：缺省把回缝后的句子送到同合云 `subtitle_line_split`
（HanLP 分词 + 词性权重 + 按你所选样式模板与真实画布实算的宽度预算，**0 积分**、照留痕），
拿回的每一行再按**字级时码**贴回时间线——行首行尾落在真正开口的那个字上，不是按字数比例内插。

投影也改成字级：口播剪辑常在句内剪口吃 / 重读，以前整句文本会把剪掉的字显示回来（真机一份 52 句工程，
88% 的字幕文字对不上那一刻说的话）；现在只有时间线上存活的字才上轨，被剪成多片的同一句按时间线序拼回一条。

相邻字幕的空隙桥接阈值从 0.5s 放到 **1.5s**：语义对齐剪映的「自动填充文本空隙」，句间换气（真机 0.5~1.3s）
不再留黑屏闪断；≥1.5s 的真实停顿仍然不硬填。`--max-gap` 照旧可调，0 关。

云端不可达（没配 key / 离线 / 超时）**不报错**：回缝后的句整句上轨、长句未拆，WARN 说清楚下一步；
`--json` 多了 `splitter` / `cloudUnavailable` / `cloudDegraded`。要走老的本地拆窗器加 `--offline`
（它已冻结、只做兜底；`--max-units` 只在离线下有意义）。两条 skill 里「字幕纯本地零云端」的说法随之改口。

### 内部重构：时间换算收敛到一处

秒 / 毫秒 / 帧换算（`sec2frame / f2ms / derive` 与 17 处各自复制的 `r3`）收敛到 `src/lib/frame-domain.ts` 一份正本，行为零变化——不改任何写出值与取整方向。

## 1.1.4（2026-09-06）

### AI 片段回填不用再手搓脚本了

`gtrk ai-drama lay` 收下 AI Drama Desk 的 return-v1 导出包，把你在外面生成好、自己挑过的片段
确定性地铺成一条独立 AI 轨——**纯本地、零模型调用、零计费**，生成那一步仍然发生在你和外部平台之间。

在这之前，回填是靠现写脚本干的。真机上那份脚本把 `setpts` 系数写反过一次（本该放慢写成了加速，
差了 0.42 秒才被发现），而且每条片子都要重写一遍、工程文件上不留任何登记。

两条你会撞到的行为：

- **不完整的包整批拒收**。导出清单里只要还有镜头没导出，命令直接报错、一个 clip 都不铺——
  半个包铺进去，成片会在那个窗口无声无息地缺镜。
- **素材比窗口短就留空档**，不拉伸也不循环。末镜尽量吸收到窗口终点，但不会为了填满而凭空造帧。

已经铺过的 AI 轨若被你在客户端拖动过，重跑会拒绝覆盖并提示 `--replace-all`；判不准时一律按
「拒绝覆盖」处理——手调丢了不可逆，多问一次便宜得多。

## 1.1.3（2026-09-05）

### 成片终于有人声了

`gtrk render` 此前只混 `audio_track`，**视频 clip 自带的音轨从来没进过混音**——口播工程的人声正是
跟着视频素材走的，所以渲出来的成片实测只有 −70 LUFS（数字静音）。现在遍历全部 `video_track`
取内嵌音轨，与 BGM 一起混，收口加上与客户端同口径的限幅与总音量。

叠加轨（B-roll / AI 再现）的原声默不作声——静音的**唯一依据是 `muted` 字段**，铺轨命令落轨时
写什么就是什么，渲染器不按轨序或车道名自作主张。解说链里要保留原片原声的片段，把该轨 `muted`
置 `false` 即可。工程一个音源都没有时会明说「将出无声成片」，成片照常产出。

### 整片没声音的片子不会再被报成合格

上面那条缺陷之所以能一路走到交付，是因为 QC 把静音一律判成提示级——一段留白和整片哑掉用的是
同一个级别。现在按整片响度（`ebur128` 的 integrated loudness）单独判定，低于 −50 LUFS 判严重、
退出码非零。逐段静音仍是提示级，一个字没动。

已知边界：只有极轻 BGM、刻意无人声的成片可能被误判；完全数字静音时 `ebur128` 输出 `-inf`，
按远低于阈值处理、不会漏判。

**射程**：质检的前提是你走了 `gtrk render`。只铺轨、或改由客户端出片的流程不会触发这条判定——
它是「渲出来的片子有没有声音」的闸，不是成片质量的全局保障。

### 字幕不再重复

一句话被智能剪辑切成几片后，`gtrk subtitle lay` 会给每一片都写一条**完整整句**的字幕——真机上
151 条字幕里有 39 种文本重复、共 89 个实例，时间线上肉眼可见一串重复块。现在同一句的多个片段
先按时间缝回一条再上轨（同工程 151 → 102 条，重复归零）。回缝与 `--max-gap` 是两个开关：
关掉小 gap 桥接，回缝照样生效。

### skill 过期会被主动告诉你

**`npm i -g` 只更新 CLI 包，不会刷新已经装好的 skill**——这条认知缺口让 skill 在真机上停了 43 天，
agent 一直照着废弃的作业指令干活。现在需要 skill 的命令启动时会做一次廉价核对，落后了就点名说明
并给出修复命令（`gtrk skills install` 或 `gtrk upgrade`）；一致时一个字都不输出。
`gtrk doctor` 也会显示新鲜度。`GTRK_SKILL_FRESHNESS=off` 可整块关闭。

前提是先跑过一次 `gtrk skills install`（那时才会写下比对基准）；在那之前判不出，静默跳过。

### 爆音检测此前从未生效过

**这不是阈值调优，是一个检测项从产品第一天起就是死的。** 旧版本报「爆音 0」不代表你的片子没问题——
它代表这项压根没跑出结果。两条判定腿双双恒假：true peak 的正则按同一行匹配，而 ffmpeg 把数值写在
`True peak:` 的**下一行**；另一条腿匹配的 `Number of clipped samples` **根本不是 astats 的指标**，
那行永远不会出现。而消费侧「取不到值就跳过」的写法，让解析失败和「测出来没超标」在报告里长得一模一样。

修好之后重新标定了分级，因为原来那条 −1 dBTP 是广播交付线、前提是内容已做响度归一，而成片没有：
14 条真实语料里 12 条越过它。现在 **−1 dBTP 报提示**（已越交付上限，平台二压可能被削），
**+1.0 dBTP 或样本域削波比例越限才报严重**。实测真·硬削波成片能被稳定判严重，真实语料一条不误伤。

同时补了一条闸：**测量值解析不到时会明说「本次未生效」**，不再静默放行。这个洞能潜伏一整个产品
生命周期，就是因为它连一行日志都没有。

已知边界：true peak 是 4 倍过采样的 inter-sample peak，与「听得见的失真」不是一回事——越线不等于一定难听。

### 会听懂「逐步推进」了

`docs/成片型图纸公约.md` 早就把「逐步推进（每步停等确认）」定为正式模式名，但只有图纸层认识它，
命令手册层的 skill 只认「只要这版工程」这类**范围**信号。于是用户说「先剪口播、然后我们逐步推进」
时，逃生门逐字判定为不触发，agent 一路连跑了三个 skill。现在公约新立「节奏信号识别」条款，
射程覆盖一切会自动接力的 skill；四份命令手册层 skill 的逃生门同时认范围与节奏。
没有这两类信号时，自动接力的默认一字未改。

### 其他

- `gtrk mg` 铺轨完的提示不再宣称「预览需某个 change 上线」——那个 change 在客户端
  2026-07-12 就已归档，这行字却一直在误导人。同时立下纪律：用户可见文案不得写死跨仓件名、
  目录路径或对侧上线状态断言，要表达「暂不可用」得用能自动失效的运行时判据。
- `gtrk render --json` 回执新增 `audio` 字段（音源盘点与是否无声）。

## 1.1.2（2026-09-03）

### 编排结果多了一份机读账本

`gtrk matrix lay --json` 的回执新增 `lay.arrange_run`：这一轮云端编排调了几次（`rounds` 恒在）、
每次的编排量与合计（`units_total`，幂等回放的那一轮不重复计）、本地复算与服务端产物有没有差
（`diff_count` 与 `diffs` 同在同缺，不再出现 `diff_count: 0` 却没有 `diffs` 的假「比过且一致」）。
只在真的调过云端时才出这个键；走素材矩阵、或总闸压回本地的零回归路径照旧没有。

### 服务端会回报它用的是哪一版决策算法

编排回执带 `decision_pin`：CLI 把它与自己内置的版本号比对，服务端比本机新时采纳服务端产物并把
自校验差异降为提示，比本机旧或对不上时如实告警。升级 CLI 与服务端不同步时，你会第一时间知道。

### 素材理解的判决只作用于被看过的那一段

`matrix describe` 每个候选只理解一帧，此前那一帧的 `blurry` 等判决会挂到整个候选的所有片段上。
现在判决只作用于被理解的那一段（回执里的 `describe.at_sec` 就是那一帧的时刻），其余片段按中性处理，
不再因为一帧模糊就把整条素材降权。

### 其他

- `gtrk patch`：既存违规的判定改用与位置无关的键（元素身份 + 违规码 + 证据值），在既存违规元素之前
  插入新元素不再把旧账误判成本次造成而硬拒。

## 1.1.1（2026-09-02）

两轮旅拍解说真机复盘（五条素材、27 条问题逐条求证）落地的一批修正，多数是你能直接感知的行为变化：

### BGM 对齐换了语义

- `gtrk audio lay --beat-align` 现在把 **BGM 的情绪峰值锚到成片的高潮点**，锚点前后按小节线平铺补齐；
  两侧都够长时不平铺。旧行为是把整条 BGM 往后推到首个重拍，片头会凭空多一段静音。
- 成片高潮点由拆分稿的叙事结构推定（升华段 → 转折 → 回扣 → 0.75 处兜底，兜底档会明说是猜的），
  可用 `--climax <秒>` 直接指定。
- 顺带修复：`--no-loop` 此前从未生效。

### 铺画面更准

- 关键词锚改取**原始相似度最高**的合格命中，并为锚预留第一名，不再被前面 beat 的普通槽位吃掉
  （此前钉过排第 29 的段）。
- 索引同趟解码并联黑场检测，治「叠化过黑」漏检：匀速渐变的场景切换分数被压到零，此前会把横跨两个
  镜头的过黑整段包进一颗 B-roll。
- `describe` 回执如实报「理解帧数 / 段总数」的覆盖率（`describe_coverage`），并对「描述里写了叠加物
  而对应标记为假」的帧出提示。

### 素材入口更结实

- `--dirs` / `--materials` 能表达含英文逗号的路径（重复传即可），枚举跟随符号链接（跨域照收、断链只跳不崩）。
- **全域零枚举改为硬失败**：`ok:false`、退出码 1，并点名真因（逗号切分 / 断链 / 扩展名不在白名单），
  此前是「✅ 完成 0/0」加退出码 0，agent 会接着往下跑。
- `gtrk tool` 产物目录带唯一后缀防撞，并行两条同类任务不再互相覆盖。

### 图纸与计费口径

- 旅拍图纸：开工两问补为三问（新增源片语种 / 方言，粤语写 `zh-HK`）；写稿语速改按音色的实测挂钟语速取
  （缺省约 330 字/分，不再用计费常量 240）；写稿前加素材适配性退出闸；检查点①补编排量预估。
- `is_copyright` 口径写准：`1` = 可商用（自有或已授权），`0` = 不可商用。
- describe / qc 的计费报数改按实探的成员身份：`credits_estimated` 即实耗，`credits_would_be` 为原价。

## 1.1.0（2026-09-02）

### ⚠️ 升级须知：1.0.8 铺过的工程不会自愈

1.0.8 有一处**槽位接缝**缺陷：铺出的主轨会带 −1 毫秒的同轨重叠，
`gtrk render` 检出后**硬拒**，成片渲不出来。

- **本版修掉了产生它的原因**，但**修不了已经铺坏的工程**。
- 手上有 1.0.8 铺的工程 ⇒ 重跑一次 `gtrk matrix lay --project <目录>`，
  或用 `gtrk patch trim` 逐颗修端点。
- 升级后打开旧工程仍渲不出，**不是新版没修好**，是那份工程还带着旧缺陷。

另外：服务端的新编排逻辑 2026-09-01 已上线。**1.0.8 与它不配套**——
本地复算自校验会判定不一致、弃用服务端产物改用本地编排，而那次调用**已经计费**。
也就是说停在 1.0.8 的每一次云端编排都在白花钱。请尽快升级。

### 编排取数路：本地素材缺省改走云端（补记于 2026-09-03）

这一条随 1.1.0 上线，但当时的更新日志没有写明，补记如下。

- 不传 `--arrange` 时按素材来源自动定档：**铺你自己电脑里的素材 ⇒ `cloud`**（编排在云端做，按编排量计费，
  跑前报预估并征求确认，`--yes` 跳过）；铺素材矩阵的素材 ⇒ `local`（编排仍在本机，不计费，行为逐字不变）。
- 本地素材路**不再自动回落本机**：连不上、被拒、产物违约这类系统故障直接报错，并给出逃生舱
  `--arrange local`（它是冻结的旧口径，只应急）。你自己拒绝预估确认或开了总闸，仍照旧回落，但会明说换了引擎。
- 本地复算自校验保持开启：服务端产物与本机算得不一致时如实告警，不会悄悄采纳。
- 这不是省钱开关：两条路都要花钱，只是花在不同环节（云端编排量 vs 矩阵检索次数）。

### 快速模式不再留黑片

`--gap-fill fast` 的填充顺序从三级扩到五级：

本 beat 候选 → 相邻颗粒延长 → **跨 beat 借候选** → **次地板补真画面** → 仍不够才黑片。

- **跨 beat 借**：某几句自己的候选被别的段先占光时，从全片没人用过的素材里取料。
  真机 `proj2-B` 的 B18 曾整段 8.952 秒落黑，而全片供给/需求是 4.10× ——
  不缺料，缺的是分配。借来的画面与那几句稿子相关性会弱一些，日志里**指名报出**。
- **次地板补真画面**：短于最小镜头长（1.2s）的残洞也填真画面。
  这些是快切，同样指名报出。真机三条片的黑片从 8 处降到 **0 处**。
- **逐步模式（`--gap-fill solid`）刻意保留黑片**——黑的地方就是没匹配上的地方，
  精修时一眼看得见。两档的差别现在不只是「停几次」，是**产物形态不同**。

### 新增：`gtrk audio tighten`

收紧配音的**句间**停顿，纯本地零计费。

```bash
gtrk audio tighten --project <工程目录> --dry-run   # 先看会压几处
gtrk audio tighten --project <工程目录>             # 落盘
```

- 真机实测：一条 203 秒的解说里 54 秒是句间静音（26.6%），收到 0.2 秒后全片缩到 171 秒。
- **只压跨句界的停顿**，句内换气与原声引用段一律不动。
- 产物是**原件多 clip 铺轨**，不烤新音频文件 —— 每处停顿都是可拖的刀口，随时能退回原样。
- ⚠️ 它会改变 beat 窗口，**跑完必须重铺**（命令会提醒）。建议在铺画面**之前**跑。

### 新增：`--fragment-interval`（TTS 句间停顿）

```bash
gtrk tool audio_tts_clone --text-file 稿.txt --speaker <音色> --fragment-interval 0.2
```

**仅自训音色生效**；云引擎音色传了会**明确报错**，不会静默忽略。
不传时产物与本版之前逐字节一致。云引擎音色请改用上面的 `gtrk audio tighten`。

### 其它

- 幂等回放时不再误报「已执行并计费」——服务端命中缓存回放时本就不二次扣费，
  旧版会无条件断言已计费，把用户引向一笔不存在的账。
- 随包文档订正：`audio_tts_clone` 的文本上限是 **5000 字**（旧文写 2000）；
  计量单位与单价一律以 `gtrk tool list` 实时显示为准，文档不再写死。

### 已知问题

- 极少数情况下主轨会留下 **1 毫秒**级的黑片或裸缝（30fps 下 0.03 帧，渲染不可见）。
  已立案追踪，不影响出片。

### 「刚修好的误删又出现了」——客户端版本下限（补记于 2026-09-04）

本版起，`gtrk matrix` 铺出的每一颗 clip 都带一个**产出方身份**（`producer`），
用来回答「这颗是我铺的、还是你自己复制粘贴出来的」。有了它，重铺时不会再把你复制出来的副本
当成自产物删掉。

⚠️ **但这个身份要客户端帮忙保住**，而 **2026-08-26 之前装机的打包客户端不会**——
它保存工程时是逐键重造 clip 的，不认识的键**存一次就丢**。所以：

- 用旧客户端打开工程、**保存一次**，这一批身份就没了；
- 下次再 `gtrk matrix` 重铺，判据回落到老口径（材料前缀 + 条数），
  于是**你复制出来的那颗又会被删掉**——看起来像「刚修好的毛病又犯了」。

**这不是新事故，是回落到本版之前的行为。** 处置：把客户端升级到 2026-08-26 之后的版本，
然后重跑一次 `gtrk matrix lay --project <目录>` 把身份补回去。

> 身份只在**本机 `.gtrk`** 上存在。工程上云再取回来（经 `video_project_struct` 往返）该键**不会保留**，
> 这是契约里就写好的，不是缺陷；此时 CLI 自动走老口径，行为与本版之前一致。
