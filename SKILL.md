---
name: ai-jian-koubo
description: 口播视频转录和口误识别。生成审查稿和删除任务清单。触发词：剪口播、处理视频、识别口误
---

# 剪口播

> 火山引擎转录 + AI 口误识别 + 网页审核 / 字幕格式化

## 模式

- **模式 A: 剪口播** — 转录 → 口误识别 → 网页审核 → 剪辑
- **模式 B: 转字幕** — 转录 → 格式化字幕文本（markdown，无时间戳）

## 输出目录结构

**模式 A（剪口播）：**
```
output/YYYY-MM-DD_HH-MM_视频名/剪口播/
├── 1_转录/   audio.mp3 · volcengine_v3_result.json · subtitles_words.json
├── 2_分析/   analysis.txt · sentence_map.json · restart_candidates.json · speech_errors.json · auto_selected.json
├── 3_审核/   review.html · audio.mp3 · data.json · silence_periods.json · review_log.json
│               <视频名>_cut.fcpxml   ← 网页点击「导出 FCPXML」后生成在此目录
│                                      拖入剪映 / Final Cut Pro 完成最终剪辑
└── 4_字幕/   retained_raw.txt · retained_transcript.json · corrected.txt · uncertain.md
                事实核验/{fact_map.json · fact_check_candidates.md · fact_check_evidence.json
                          · approval_template.json · approved_corrections.json · fact_corrections_applied.json}
                fact_checked.txt（仅含人工批准的事实修改）· subtitles_formatted.md
```

**模式 B（转字幕）：**
```
output/YYYY-MM-DD_HH-MM_视频名/剪口播/
├── 1_转录/   audio.mp3 · volcengine_v3_result.json · subtitles_words.json · raw_text.txt
└── 2_纠错/   corrected.txt · uncertain.md（可选）
视频所在目录/
└── subtitles_formatted.md   ← 最终输出
```

## 流程总览

```
-1. 首次引导（仅第一次：环境自检 + 配置火山引擎）
0. 确认视频路径 + 选择模式
1-4. run_transcribe.sh（自动，两模式共用）

模式 A（剪口播）:
  5.1 gen_analysis.js（含同句 / 邻句重说待审线索）
  5.2 读规则.md + 经验规则.md + analysis.txt + restart_candidates.json
  5.3 AI 判断整句口误 → speech_errors.json（只填 delete_sentences）
  5.4 auto_filler.js → 自动补充词级口癖 idx（快速预筛）
  5.5 AI 核对重说线索，并逐句扫剩余词级口癖（B2/B3/B4，脚本覆盖不到的部分）
  5.6 merge_selections.js
  6-7. 生成审核网页 + 启动服务器
  7A. 完整模型 A/B（用户显式确认时：两个 ASR 均跑 5.1–7，再盲审比较）
  【等待用户确认】→ 网页点击「导出 FCPXML」→ 拖入剪映 / Final Cut Pro 完成剪辑
       （导出同时写 3_审核/review_log.json，供步骤 8 学习）
  7B. 成片字幕（用户要求字幕时：先提取审核后保留台词 → 基础纠错 → 事实核验候选 → 人工确认 → 断行）
  8. 自进化学习（用户显式触发「已导出，学一下」）→ diff 抽规则 → 确认 → 写 经验规则.md → 团队 Git 沉淀

模式 B（转字幕）:
  B-1 提取纯文本
  B-2 第一步：纠错（只改词，不断行）→ corrected.txt
  B-2.5 审核后成片字幕的事实核验（有证据的候选，人工确认后才应用）→ fact_checked.txt
  B-3 第二步：断行（只格式化，不改字）→ subtitles_formatted.md
```

## 执行步骤

> **路径约定（重要）**：本 skill 不绑定特定 agent，**不要假设它装在 `~/.claude/skills/`**。
> 下面命令里的 `SKILL_DIR` 一律指**本 skill 的安装目录**（即你加载本 `SKILL.md` 的那个目录，
> 含 `scripts/`、`用户习惯/`）。执行前把它设成你实际加载 skill 的绝对路径即可：
> ```bash
> SKILL_DIR="<本 skill 的安装目录>"   # 例：Claude Code 默认 ~/.claude/skills/AI剪口播
> ```
> API Key 的查找顺序见 [scripts/lib/load_api_key.sh](scripts/lib/load_api_key.sh)：
> 环境变量 `VOLCENGINE_API_KEY` → `$SKILL_DIR/.env` →（兼容旧约定）上一级 `.env`。

### 步骤 -1: 首次引导（只在第一次跑）

> **目的**：第一次用本 Skill 的人通常没装依赖、没配火山引擎 key。先做一次自检并手把手引导，配好后写标记文件，**以后永久跳过，不再打扰**。

**闸门**：先看标记文件是否存在（`SKILL_DIR` = 本 skill 安装目录，见上方「路径约定」）。
```bash
SKILL_DIR="<本 skill 的安装目录>"
[ -f "$SKILL_DIR/.setup_done" ] && echo "已配置，跳过引导" || echo "需要引导"
```
- 存在 `.setup_done` → **直接进入步骤 0**，不要跑自检、不要提引导。
- 不存在 → 跑自检脚本（跨平台，Win/macOS/Linux 通用）：

```bash
node "$SKILL_DIR/scripts/doctor.js"
```

`doctor.js` 做三层检查并输出人话报告：① 系统依赖（ffmpeg/node/python3/curl）② `VOLCENGINE_API_KEY`（环境变量或 `.env`，查找顺序见 `scripts/lib/load_api_key.sh`）③ 联网实测 key 与极速版/标准版两个资源是否开通。**全绿时它自己写 `.setup_done` 并退出 0**；有缺项退出 1。

**AI 按报告分情况引导用户**（不要让用户自己看懂报告）：
1. **缺系统依赖** → 把报告里对应平台的安装命令复制给用户（脚本已按 Win/Mac 给好），让其装完。
2. **缺 / 占位 API Key** → 按以下流程引导用户（火山引擎·豆包语音服务，共 40h 免费额度）：
   1. 登录控制台 https://console.volcengine.com/speech/new/overview
   2. 左侧「语音识别」→ 开通「录音文件识别 1.0」，**标准版 + 极速版都开**（各 20h、共 ≈40h，独立抵扣）
   3. 左侧「API Key 管理」→ 复制 API Key
   4. 写入 `$SKILL_DIR/.env`（推荐，跟着 skill 走；也可 `export VOLCENGINE_API_KEY=...`）：
   ```bash
   echo "VOLCENGINE_API_KEY=粘贴你的key" >> "$SKILL_DIR/.env"
   ```
3. **某个资源未开通**（报告会精确指出是极速版还是标准版）→ 引导去控制台开通对应「录音文件识别 1.0」资源；默认 auto 轮流需两个都开（各 20h 免费、共 ≈40h），只想用一个就转录时加 `--flash` / `--v3-standard`。
4. 用户修完 → **重跑 `node "$SKILL_DIR/scripts/doctor.js"`**，直到全绿（自动写 `.setup_done`），再进入步骤 0。

> 全程不要替用户去控制台点按钮或粘贴他的私有 key 到别处；只给清晰可复制的命令和链接。

### 步骤 0: 确认视频路径 + 选择模式

收到视频路径后，**先展示确认**，格式：

```
📹 视频：/path/to/视频.mp4
📁 输出：~/Desktop/output/YYYY-MM-DD_HH-MM_视频名/剪口播/

请选择模式：
  [A] 剪口播 — 识别口误 → 网页审核 → 导出 FCPXML 给剪映 / FCP
  [B] 转字幕 — 转录 → 格式化字幕文本（markdown，无时间戳）
```

用户确认后再继续，不自动开始。

### 步骤 1-4: 一键转录流水线（无需 AI）

```bash
SKILL_DIR="<本 skill 的安装目录>"   # 见上方「路径约定」
VIDEO_PATH="/path/to/视频.mp4"
BASE_DIR="$HOME/Desktop/output/$(date +%Y-%m-%d_%H-%M)_$(basename "$VIDEO_PATH" | sed 's/\.[^.]*$//')/剪口播"

bash "$SKILL_DIR/scripts/run_transcribe.sh" "$VIDEO_PATH" "$BASE_DIR"
# 输出: BASE_DIR/1_转录/{audio.mp3, volcengine_v3_result.json, subtitles_words.json}
#
# 默认引擎: auto 轮流（flash 极速版 auc_turbo ↔ 标准版 auc 交替）
#   - 每次转录自动切换引擎，分摊两份各 20h 免费额度 ≈ 共 40h
#   - 单 X-Api-Key 认证，base64 直传，不依赖外部图床
#   - 需在控制台同时开通极速版(auc_turbo)与标准版(auc)两个资源
#   - 限制: 音频 ≤ 2h、≤ 100MB
# 可选引擎（只开了一个资源、或想固定用某个时加）:
#   --flash        只用极速版（一次直出、最快）
#   --v3-standard  只用标准版（异步 submit/query 轮询）
#   --seedasr2     只用录音文件识别 2.0（SeedASR，需单独开通 2.0 资源）
```

### 步骤 5: 生成分析文件 + 口误识别

#### 5.1 生成分析文件

```bash
node "$SKILL_DIR/scripts/gen_analysis.js" \
  "$BASE_DIR/1_转录/subtitles_words.json" \
  "$BASE_DIR/2_分析"
# 输出: analysis.txt + sentence_map.json + restart_candidates.json + auto_selected.json
```

#### 5.2 读取规则 + 分析文件

读 `用户习惯/规则.md`、`用户习惯/经验规则.md`（自进化沉淀的个人偏好，见步骤 8）、`analysis.txt` 和 `restart_candidates.json`。
两份规则都要遵守；冲突时以更具体、更新的为准。

`restart_candidates.json` 是脚本根据“前短后长”的重复锚点产生的**待审核线索**，可能来自同一句，也可能来自相邻 1–3 句。它不是删除任务：每条都必须回听并做语义确认；`suggestedDelete` 只是初始锚点，必要时结合 `sourceSentenceRange` 缩放到草稿的真实起止。只有前段确实是草稿/残句、后段更完整时，才把确认后的 idx 写进 `speech_errors.json`；普通重复、列举、固定说法或不确定的情况不打删除标。

`analysis.txt` 格式（每行一句，序号: 文本）：
```
0: 直接开始了啊
1: 这是深圳腾讯总部楼下
2: 就为了安装一只
```

#### 5.3 AI 判断整句口误（只填 delete_sentences）

> ⚠️ 由你直接阅读 `analysis.txt` 并判断哪些**整句**是口误。
> **本步只填 `delete_sentences`**，`delete_idx` 留空数组。词级口癖留到 5.4（脚本）+ 5.5（AI 补漏）。

按 `规则.md` 的 **A 节（整句删除）** 判断：重复重说、残句、句内卡顿、只含语气词的整句等。对 `restart_candidates.json` 里的线索，若草稿只占原句的一部分，不要因方便而整句删；先在 5.5 取到精确词级 idx，再以预选删除标送入审核页。

**输出格式**（写入 `$BASE_DIR/2_分析/speech_errors.json`）：
```json
{
  "delete_sentences": [2, 3, 8, 10],
  "delete_idx": []
}
```

#### 5.4 脚本自动识别词级口癖（无需 AI）

```bash
node "$SKILL_DIR/scripts/auto_filler.js" \
  "$BASE_DIR/2_分析/sentence_map.json" \
  "$BASE_DIR/1_转录/subtitles_words.json" \
  "$BASE_DIR/2_分析/speech_errors.json"
```

脚本会**就地修改** `speech_errors.json`，把识别到的口癖 idx 合并进 `delete_idx`：

- 任意位置：`呃 / 嗯 / 额 / 诶 / 欸 / 唉 / 噢`（已排除"额外/金额"等真词）
- 任意位置的：`然后`（用户偏好：宁可手动加回）
- 句首过渡词：`然后 / 那么 / 好的 / 哦 / 哎 / 呀 / 对 / 那`（"那"会避开"那个/那么/那里"等）
- 句尾废词：`对 / 哦`
- 自然语气词「啊」「呢」默认由经验规则保护；仅在语义分析确认它独立成句、连续堆叠、明显卡顿或明显无功能时才标记删除。不得仅因「呢」处于句首/句尾而删除。
- 跳过已整句删除的句子；保护剩余字数 ≤3-4 的短句不被掏空

跑完后，用户已手工填的 idx 也会被保留（合并去重）。

#### 5.5 AI 逐句扫剩余词级口癖（脚本覆盖不到的部分）

脚本只处理"无需上下文判断"的安全口癖。AI 在此结合 `analysis.txt` 与 `restart_candidates.json`，找出脚本覆盖不到的：

- **B4 同句 / 邻句重说**（优先级最高）：前半段说错、说到一半或较短草稿，后半段 / 后句以同主题更完整地重说 → 在确认后删前半段，保留后半段。`restart_candidates.json` 只提供重复锚点和建议范围，不能跳过语义确认直接删除。
- **B3 冗余引导短语**：大家可以看到、你看、给大家看一下、比如说你看一下、我可以告诉你、你明白吗
- **B2 句中填充词**（**慎用**，需明确判断为口癖才删）：其实、就、也、大概、这个、那个、就是
- **B5 脚本未覆盖的句尾拖音**

**工作方式（避免 token 爆炸 + 过删）：**
1. 先核对 `restart_candidates.json`：只有“前短后长、后者可独立表达”的重说才转成删除标；随后顺序扫 `analysis.txt`，只标"明显有问题"的句子。没明显问题的句子直接跳过，不要为了"也许能再删一点"硬挑刺。
2. 把候选句号攒成一批（建议 20-30 句一组），**一次** `gen_word_detail.js` 调用拿到词级 idx。
3. 把新增 idx **合并**写回 `speech_errors.json` 的 `delete_idx`（与 5.4 结果取并集，不要覆盖）。

```bash
# 一次传多个句号，减少往返
node "$SKILL_DIR/scripts/gen_word_detail.js" \
  "$BASE_DIR/2_分析/sentence_map.json" \
  "$BASE_DIR/1_转录/subtitles_words.json" \
  5 8 12 24 25 44 ...
```

**判断尺度**：句子已经能读通就不要再动。剪口播的容错来自审核网页（用户能取消勾选），但**误删比漏删难恢复**——用户得手动取消勾选才能找回。所以**漏删优于过删**。

#### 5.6 合并到 auto_selected（代码自动映射句号→idx）

```bash
node "$SKILL_DIR/scripts/merge_selections.js" \
  "$BASE_DIR/2_分析/sentence_map.json" \
  "$BASE_DIR/2_分析/speech_errors.json" \
  "$BASE_DIR/2_分析/auto_selected.json"
```

### 步骤 6-7: 生成审核数据并启动服务器

```bash
# 6. 生成 data.json + review.html（从 templates/review.html 复制）
#    前端模板在 scripts/templates/review.html，改样式直接改那里
node "$SKILL_DIR/scripts/generate_review.js" \
  "$BASE_DIR/1_转录/subtitles_words.json" \
  "$BASE_DIR/2_分析/auto_selected.json" \
  "$BASE_DIR/1_转录/audio.mp3" \
  "$BASE_DIR/3_审核"

# 7. 启动审核服务器
#    serve_review.sh 会自动选端口、在【一个独立的 OS 终端窗口】里前台运行服务器、
#    健康检查、打开浏览器；若环境禁止开新窗口，会打印一条手动命令兜底。
#    （不要再用 `&` / nohup 在 agent 后台挂服务——见下方「为什么」。）
bash "$SKILL_DIR/scripts/serve_review.sh" \
  "$BASE_DIR/3_审核" "$VIDEO_PATH" "$SKILL_DIR/scripts/review_server.js"
```

### 步骤 7A：完整模型 A/B（显式确认后才运行）

> 只在用户明确要求比较不同 ASR 的**完整剪口播效果**时运行。不能拿「1.0 完整链路」和「2.0 裸转录」比较；两组必须只替换 ASR，其余规则、口误分析、审核和切点参数完全相同。

1. **先验证资源**：录音文件识别 2.0 是可选资源，完整 A/B 前运行：

   ```bash
   node "$SKILL_DIR/scripts/doctor.js" --ab
   ```

   若 2.0 未开通，停在此处引导用户开通；不得悄悄把 B 回退为 1.0。

2. **建立两组隔离工件**：同一源视频只抽一次共享音频，A=当前 1.0 Flash、B=录音文件识别 2.0。运行：

   ```bash
   bash "$SKILL_DIR/scripts/run_model_ab.sh" \
     "$VIDEO_PATH" "$AB_DIR"
   ```

   输出的 `manifest.json` 会冻结视频/音频哈希、Git 版本、`规则.md`、`经验规则.md`、`SKILL.md` 和运行脚本快照。脚本会为两组生成 `analysis.txt` 与 `restart_candidates.json`，但**不会**把空的 `auto_selected.json` 直接送入审核页。

3. **同一口误分析层必须跑两次**：对 `A/2_分析/analysis.txt`、`A/2_分析/restart_candidates.json` 和 B 的对应文件，分别读取 `$AB_DIR/contract/` 中冻结的规则，按步骤 5.3–5.5 各自写 `speech_errors.json`。重说线索必须逐条做语义确认，确认后才变为预选删除标；不得复制另一组的 idx，因为 ASR 的分词和句界不同。

   分析完成后，为每组显式落完成标记：

   ```bash
   node "$SKILL_DIR/scripts/mark_model_ab_analysis_complete.js" "$AB_DIR/A/2_分析" coding-agent
   node "$SKILL_DIR/scripts/mark_model_ab_analysis_complete.js" "$AB_DIR/B/2_分析" coding-agent
   ```

4. **生成盲审页**：

   ```bash
   bash "$SKILL_DIR/scripts/complete_model_ab.sh" "$VIDEO_PATH" "$AB_DIR"
   ```

   此步才会对 A/B 都运行 `auto_filler.js → merge_selections.js → generate_review.js`。审核页只显示 A/B 标签，不显示模型身份；用户都审核、导出 FCPXML 后，才运行：

   ```bash
   node "$SKILL_DIR/scripts/compare_model_ab.js" "$AB_DIR"
   ```

5. **按源时间轴判分**：比较脚本把每组的候选和最终选择映射为源视频时间区间，输出候选精确率、召回率、人工撤销/补删、审核时长和切点安全。不得直接比较词级 idx；两组的 idx 不可比。任何一组出现保留发音被切断或保留片段重叠，本次 A/B 无效，不得据此切换默认模型。

6. **模型切换是独立决策**：A/B 的结果只产生证据，不自动改 `run_transcribe.sh` 的默认 `auto`。至少复核普通口播、专有名词、真实口误三类样本后，再由用户确认是否切换默认模型。

### 剪切安全规则（生产默认）

审核页和 FCPXML 导出共用 `scripts/lib/compute_keeps.js`。生成的静音/换气候选会先与逐字时间轴求交，只保留字与字之间的空隙；句头/句尾余量也会受字边界保护。因此任何自动吸附或内部静音切割都不能落在一个正在发音的字中间。若 ASR 的字时间戳不准，默认宁可少切一点静音，也不切断发音。

导出时源片段再统一量化到视频帧，并修复相邻片段的 1 帧重叠，避免导入剪映/Final Cut 后出现重复帧或突兀断点。

> **⚠️ 为什么必须用 `serve_review.sh`，不能直接后台 `&`/nohup 挂服务（重要，否则用户会「拒绝连接」）：**
> 审核网页要这个本地服务**一直监听端口**。但各 agent 对后台进程的处理不同：
> - **Claude Code** 有常驻进程管理器，会在整个会话期间替你保活后台进程 → 直接 `&` 也没事；
> - **某些 agent（如 Codex）** 把每条命令放在临时子进程/沙箱里，命令一返回就**回收整棵进程树**
>   （连 `nohup`/`disown` 的子进程也杀）→ 端口失联，浏览器报「localhost 拒绝了连接请求」。
>
> 所以**不要依赖 agent 替你保活**。`serve_review.sh` 改在 OS 层另起一个真正的终端窗口前台运行
> （macOS 写可双击的 `.command` 并 `open`；Linux/Windows 起对应终端），它由系统拥有、不随 agent
> 命令回收。脚本最后还会打印一条 `bash "<3_审核>/启动审核服务.command"` 的手动命令——
> 万一连开窗口都被禁，让用户在自己的终端里跑这一条、**保持窗口开着**即可。
>
> 服务器启动时会把地址写进 `3_审核/server_url.txt`、进程号写进 `.review_server.pid`，方便排障。

用户在网页中：播放片段确认 → 勾选/取消 → 点击「导出 FCPXML」→ 生成的 `*_cut.fcpxml` 拖入剪映或 Final Cut Pro 完成最终剪辑。

> **导出时服务器同时写一份 `3_审核/review_log.json`**（与 FCPXML 同一次点击产出）：记录
> AI 初选 idx、用户最终 idx、切割参数，以及二者**词级 diff**（带文字+句子上下文）。
> 这是步骤 8「自进化学习」的唯一原料，**不读 `.fcpxml`**（那是算完的时间线，丢失了词级选择）。

### 步骤 7B：从审核结果导出成片字幕

> 当用户要的是**已经审核、已经剪掉口误后的成片字幕**时，不能回到 `1_转录/subtitles_words.json` 直接全文导出。必须先有本次审核的 `review_log.json`，再从其中的 `finalSelected` 提取保留台词。

```bash
node "$SKILL_DIR/scripts/extract_retained_transcript.js" \
  "$BASE_DIR/3_审核"
# 输出: $BASE_DIR/4_字幕/retained_raw.txt
#       $BASE_DIR/4_字幕/retained_transcript.json
```

脚本保留原始逐字 idx 与时间轴不变，只在新的字幕文本层排除最终选中的台词；审核时只选中的静音段不会误删文字。若缺少 `review_log.json` 或其中没有 `finalSelected`，**停止并提示用户先在审核页导出**，不得退回完整原始 ASR。

然后按下方「模式 B」的 B-2、B-2.5、B-3 继续，但输入改为 `$BASE_DIR/4_字幕/retained_raw.txt`，输出在同目录下。

> 本阶段的事实核验采用固定安全规则：**自动发现、自动搜索、自动给证据；人工确认后才应用。** 基础纠错不会自动全篇替换人名或专有名词；词形不确定时先保留 ASR 原文并写入 `uncertain.md`。

### 步骤 8: 自进化学习（用户显式触发）

> **不自动跑。** 用户导出后，在**任意会话**说「<项目> 已导出，学一下」之类，才执行本步。
> 本步只读文件、不依赖对话上下文还在，所以冷会话也能跑。

1. **定位日志**：单个项目读 `<project>/剪口播/3_审核/review_log.json`；
   批量重学则 glob `~/Desktop/output/*/剪口播/3_审核/review_log.json`，逐个汇总。
   （日志只存在项目里，清理 output 会丢语料。）
2. **读现有规则**：先读 `用户习惯/经验规则.md` **全文** + `用户习惯/规则.md`，避免重复提已有规则。
3. **看 diff 抽规则**：对每条 `diff.aiOnly`（AI 想删你留回，可能过删）和 `diff.userOnly`
   （你删了 AI 没想到，可能漏删），对比「AI 为何这么剪 vs 你为何这么剪」，
   抽象出**能泛化到下一条视频**的通用偏好。**严禁**把单条口误/语境例外固化成规则。
4. **违例提醒**：若 diff 显示用户违反了某条已有规则，**逐条提醒**用户，让其判断
   是「正当例外（规则不动）」还是「该改松/加例外条件」。
5. **列给用户确认**：把候选的【新增 / 细化已有 / 合并重复 / 改某条】列出来，**等用户确认**。
6. **写入**：确认后才改 `用户习惯/经验规则.md`，每条带出处标签 `（学于 <视频名> YYYY-MM-DD；已确认）`。
   下次步骤 5.2 即生效。
7. **团队 Git 沉淀**：若当前使用的是团队仓库工作副本，先校验再提交。只提交规则文件，绝不提交视频、音频、转写结果、审核日志或 API Key：

   ```bash
   node "$SKILL_DIR/scripts/validate_experience_rules.js" \
     "$SKILL_DIR/用户习惯/经验规则.md" --require-confirmed

   bash "$SKILL_DIR/scripts/submit_experience.sh" "<来源视频或本次学习主题>"
   ```

   `submit_experience.sh` 会拒绝未确认规则、疑似凭证和已暂存的无关文件；它只创建并推送
   `用户习惯/经验规则.md` 的独立 `learn:` commit。若同事没有远程写权限，脚本会保留本地
   commit 而不会 pull、rebase 或 force push；由仓库维护者按团队协作流程处理。Git commit 的作者
   即为本次经验贡献者。

### 模式 B: 转字幕

> 步骤 1-4 完成后，如果用户选了模式 B，执行以下步骤。
> **两步拆分**：先纠错，再断行。两步必须分开进行，不要混为一步。
>
> 若字幕来自已审核的剪口播项目，优先走「步骤 7B」，并把 `$BASE_DIR/4_字幕/retained_raw.txt` 作为本节输入；不得重新从完整原始 ASR 提取。

#### B-1 提取纯文本（脚本执行）

```bash
node "$SKILL_DIR/scripts/extract_text.js" \
  "$BASE_DIR/1_转录/subtitles_words.json" \
  "$BASE_DIR/1_转录"
# 输出: $BASE_DIR/1_转录/raw_text.txt
```

#### B-2 第一步：纠错（AI 处理）

1. 读取输入文本：直接转字幕模式为 `$BASE_DIR/1_转录/raw_text.txt`；审核后成片字幕为 `$BASE_DIR/4_字幕/retained_raw.txt`
2. 读取 `$SKILL_DIR/用户习惯/纠错prompt.md` 规则
3. **只做纠错**，不断行、不去标点、不改格式
4. 输出到与输入同一流程的纠错目录：直接模式为 `$BASE_DIR/2_纠错/corrected.txt`；审核后成片字幕为 `$BASE_DIR/4_字幕/corrected.txt`（每行一句，与输入 1:1 对应）
5. 如有「不确定清单」，输出到同目录 `uncertain.md` 并在对话中列出给用户。人名、专有名词不确定时保留原 ASR，不得猜测后全篇替换。

#### B-2.5 审核后成片字幕的事实核验（自动发现、联网/声学核验，人工确认）

> 只用于已走完「步骤 7B」的成片字幕：它需要 `retained_transcript.json` 保留的逐字时间轴，当前不对直接转字幕模式伪造时间映射。

1. 输入是完整的 `$BASE_DIR/4_字幕/corrected.txt`。模型先读全文生成**短事实 brief（关键词串）+ 主题关键词 + 事实候选地图**，发现高风险的：人名、机构/公司、产品、地点、奖项、日期、数字、术语；有限核验名额必须优先给疑似 ASR 同音/形近错写和与事件名单不一致的实体，已正确事实后置。
2. **绝不把全文直接作为搜索词，也不只拿主题搜索。** 每个候选的联网查询包必须是「候选原文变体 + 文案 brief + 主题关键词 + 本地出现上下文」。
3. 模型使用 **Doubao Seed 2.0 Lite**（配置名 `doubao-seed-2.0-lite` 会自动解析为当前 Responses API 端点 `doubao-seed-2-0-lite-260215`）和方舟内置 Web Search。模型不输出“建议”或 JSON，只填写固定标签文本；脚本严格翻译为 JSON 工件并收集 Web Search 来源。`ANSWER` 和 `CONFIDENCE` 是下游机器字段，`REASON` 只给人工审阅，不能驱动自动应用：

   ```text
   [ANSWER]
   ANSWER: 邓玉 -> 邓煜
   CONFIDENCE: 0.99
   REASON: 北大官方名单列为邓煜
   [/ANSWER]
   ```

   无法确认时只把 `ANSWER` 写为 `uncertain`。答案只能替换单一、短的实体/日期/术语；句子级或越界文本会被本地合同拒绝。已证实原文无误时，报告显示 `原文 -> 原文` 且无需应用。
4. 脚本只写入 `4_字幕/事实核验/`，**绝不修改** `corrected.txt` 或 `subtitles_formatted.md`。先把 `fact_check_candidates.md` 给用户审阅并等待明确的候选 ID 决定。

```bash
# 先验证本机未提交的 ARK_API_KEY、模型、Web Search、火山引擎 Key 和声学复核依赖；不会显示 Key
node "$SKILL_DIR/scripts/check_fact_check_config.js" \
  --model "${FACT_CHECK_MODEL:-doubao-seed-2.0-lite}" --web-search --audio-recheck

# 自动生成事实地图、联网证据与人工审批模板；不会应用任何修改
node "$SKILL_DIR/scripts/fact_check_subtitles.js" \
  "$BASE_DIR/4_字幕" \
  --model "${FACT_CHECK_MODEL:-doubao-seed-2.0-lite}"
```

5. **裸数字声学复核（自动，绝不猜单位）**：对 `72` 这类仅含阿拉伯数字、可能缺 `%` 的 NUMBER 候选，先用其原始逐词时间轴从 `1_转录/audio.mp3` 连续截取“候选前 2 秒 + 候选后 2 秒”（不删静音、不拼接），再固定调用 1.0 极速版 `--verbatim`：`enable_itn=false`、`enable_punc=false`、`show_utterances=true`。随后把首遍 ASR 文本、二遍原样文本、候选时间和切片规则一起交给 Doubao Seed 2.0 Lite；模型只能在 `原文裸数字` / `同值%` / `uncertain` 中用 `[AUDIO_DECISION]` 固定文本作答，不能联网猜单位或输出 JSON。
6. 声学复核失败、时间轴缺失、二遍文本没有明确说出“百分之”、或模型越出允许选项时，必须是 `uncertain`；不得退回纯文本/联网猜测。声学结论和首末时间、两遍文本、切片规则会进入 `fact_check_evidence.json` 与候选报告，**仍需人工批准**才可应用。

生成后必须展示 `$BASE_DIR/4_字幕/事实核验/fact_check_candidates.md` 中的证据，并等待用户明确确认。例如：

```bash
# 用户确认后才记录决定；本命令仍不改字幕
node "$SKILL_DIR/scripts/approve_fact_corrections.js" \
  "$BASE_DIR/4_字幕" --approve FC-001,FC-003 --reject FC-002 --by "审核人"

# 仅把获批准的精确出现位置写到独立文本层；保留 corrected.txt 不变
node "$SKILL_DIR/scripts/apply_fact_corrections.js" "$BASE_DIR/4_字幕"
# 输出：$BASE_DIR/4_字幕/fact_checked.txt
```

批准文件与候选文件绑定当前 `corrected.txt` 的 SHA-256；字幕或候选一旦变化，旧决定会被拒绝，必须重新核验。`fact_corrections_applied.json` 会记录每次实际替换对应的原始逐字索引和时间范围。

#### B-3 第二步：断行（AI 处理）

1. 读取纠错后的文本：直接模式为 `$BASE_DIR/2_纠错/corrected.txt`；审核后成片字幕在有人工批准的事实修改时读取 `$BASE_DIR/4_字幕/fact_checked.txt`，否则读取 `$BASE_DIR/4_字幕/corrected.txt`
2. 读取 `$SKILL_DIR/用户习惯/断行prompt.md` 规则
3. **只做格式化**，不改字、不删字、不加字；默认每行最多 10 个中文字量，英文专有名词不得从单词中间强拆
4. 输出到：直接模式为视频所在目录 `$(dirname "$VIDEO_PATH")/subtitles_formatted.md`；审核后成片字幕为 `$BASE_DIR/4_字幕/subtitles_formatted.md`
5. 告知用户文件路径，流程结束

---

## 配置

火山引擎 API Key 通过 `VOLCENGINE_API_KEY` 提供，查找顺序见 [scripts/lib/load_api_key.sh](scripts/lib/load_api_key.sh)：
环境变量 → `$VOLCENGINE_ENV_FILE` → `$SKILL_DIR/.env` →（兼容旧约定）skill 上一级的 `.env`。推荐写在 `$SKILL_DIR/.env`：
```
VOLCENGINE_API_KEY=your_api_key_here
```

事实核验使用方舟 Responses API，默认产品模型为 `doubao-seed-2.0-lite`；脚本会把这个产品名解析为当前正式端点 `doubao-seed-2-0-lite-260215`，可用 `FACT_CHECK_MODEL` 显式覆盖。如 `.env` 不在 skill 目录，可用 `ARK_ENV_FILE` 指向它：
```
ARK_API_KEY=your_ark_api_key_here
FACT_CHECK_MODEL=doubao-seed-2.0-lite
```

方舟 Web Search 必须已开通。事实核验只向方舟发送审核后成片字幕与候选查询上下文，返回的来源会保存在本机项目输出目录；Key 永不写入候选、日志或 Git。

去[新版控制台](https://console.volcengine.com/speech/new/overview)生成 **一个** API Key 即可——所有引擎共用这同一个 `VOLCENGINE_API_KEY`（均为新版控制台单 `X-Api-Key` 认证）。

默认 `auto` 轮流模式会交替用极速版和标准版，**需同时开通两个资源**：「录音文件识别 - 极速版」（`volc.bigasr.auc_turbo`）+「录音文件识别 - 标准版」（`volc.bigasr.auc`）。两者各有 20h 免费额度、各自独立抵扣，轮流即可吃满 ≈40h。若只想/只开通了其中一个资源，加 `--flash` 或 `--v3-standard` 固定使用。
