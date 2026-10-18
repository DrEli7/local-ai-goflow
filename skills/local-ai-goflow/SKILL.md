---
name: local-ai-goflow
description: Delegate short low-risk text tasks and bounded project text/data file tasks to local Qwen3 with selected-file tools, trusted checks and GPT acceptance. Ordinary coding uses guarded GoFlow. Use for local/Go/GPT coordination; exclude external facts, long documents, arbitrary shell, high-risk changes and image understanding.
---

本机所有项目和后续新聊天默认自动分工，无须用户重复提醒：简单短任务尽量先用本机 Qwen3，普通编码功能包交给 Go，GPT 负责判断、审核和最终答复。用户本轮选择、已保存模式及适用项目规则优先；此技能不自行切换模式或启用服务。现有 GoFlow 收费、额度、隔离和审核规则继续适用。不要把节省额度当作已测得的百分比。

## 分工

- 先尊重用户本轮或现有的强制 GPT、强制 Go、关闭自动委派选择；`off/gpt` 不自动本地委派，`go` 走原 GoFlow。用户直接要求本地模型时，可执行明确授权的本地任务。
- 对有明确输入的短摘要、改写、翻译、分类、字段提取、代码解释和不落盘的简单代码草稿，优先调用 `local_ai_task`。不用先让本地模型判断风险；风险由当前 GPT 判断。
- 用户要求整理当前项目内的短文本、JSON 或 CSV，并包含读取文件、保存结果或固定检查命令时，优先调用 `local_ai_agent_run`。GPT 按用户需求先明确项目内的输入文件、允许写入文件和命令清单；Qwen 在受限工具循环中读取选定文件、生成快照候选并执行受信检查。GPT 读取真实候选和命令结果后，通过 `local_ai_agent_accept` 审核落盘。普通编码仍交 Go。
- 需要网络事实、复杂算法、安全/账户/系统操作、大范围改动或长文档，由 GPT 负责核心判断；复杂父任务仍按 GoFlow 路由拆出独立普通功能包。普通功能包由 Go 编写实现与完整测试，GPT 负责必要集成、阅读实际差异和测试证据并审核应用。本地 agent 不开放任意 shell、全盘文件访问或自行批准写入；原 `local_ai_task` 保持纯文本候选通道。
- 开始本地代码工作仍先遵守全局 GoFlow 的 status/usage/route 检查。新增本地通道不会改变 GoFlow 的 `opencode-go` allowlist。普通可隔离代码任务需要 Go 接手时使用原 GoFlow 的 submit/test/GPT review/accept，不把本地结果伪装为 Go 的任务。

GoFlow 提交中的 `files` 只列已经存在、明确选择的输入文件；现有可编辑文件同时列入 `files` 和 `editableFiles`，待新建文件只列入 `editableFiles`，不要创建空占位。完全新建且不需要已有输入的功能包使用 `files: []`，例如 `files: []`、`editableFiles: ["tags.mjs", "tags.test.mjs"]`。实现和完整测试仍由 Go 交付；本插件的交接计划不会替代原 GoFlow 的快照检查或提交。

## 调用与验收

有 MCP 工具时直接调用 `local_ai_status`、`local_ai_task`、`local_ai_review`、`local_ai_agent_run`、`local_ai_agent_task`、`local_ai_agent_accept`、`local_ai_metrics`、`local_ai_goflow_plan`。按工具实际 schema 提供参数。自动本地任务必须提供真实 projectDirectory，入口会核实保存的 GoFlow 模式；其旧额度缓存不是当前许可。仅当用户直接点名本地执行本项任务时，才设 explicitLocalRequest=true 覆盖保存的路由偏好，不覆盖插件/工具禁用或审批。Go 额度阻塞不代表本地推理不可用；保存模式无法确认或项目无效时不得猜测许可。

### 项目文件与受限命令

`local_ai_agent_run` 接收真实 `projectDirectory`、最长 2000 字符的 `task`、最多各 8 个项目相对路径的 `readFiles` 与 `writeFiles`、明确的 `commands`、GPT 判断的 `risk` 和 3–8 步的 `maxSteps`（默认 8）。只列完成这项需求必需且不含凭据的文件，不能把整个仓库或私密配置作为输入。待新增结果只放 `writeFiles`，已有文件是否可读、可写分别明确声明。文件工具和路径校验由宿主执行，不能因模型提出路径而放宽范围。

已有写入目标必须同时列入 `readFiles`。单文件最多 16 KiB、选定原始输入合计最多 32 KiB，要求有效 UTF-8；写入类型限 `.txt/.md/.json/.csv/.tsv/.yaml/.yml/.xml/.log/.rst`。代码文件的实现与修改走 GoFlow，不能因为本地 agent 支持读取代码或检查语法就用它替代普通编码委派。

命令仅接受已声明的 `{id, kind, path?}`。`kind` 为 `text_stats`（文本统计）、`json_validate`（JSON 解析检查）、`csv_stats`（CSV 统计）、`javascript_check`（JavaScript 语法检查）或 `node_version`（固定 Node 版本查询）；它们由受信执行器运行，不接受自定义命令行、shell、环境变量或任意程序。`javascript_check` 不执行项目代码，也不能代替完整项目测试。需要自定义终端命令或代码实现与测试时，继续由 GPT 或原 GoFlow 处理，不把普通编码改成本地任务绕过既有流程。

运行结果仅为候选与真实执行证据。用 `local_ai_agent_task({taskId})` 读取实际候选文件、命令 `exitCode` 与 `candidateHash`，核对需求、文件范围、失败结果及原文件变动后，才调用 `local_ai_agent_accept({taskId,candidateHash,reviewer:'GPT',decision:'approve'|'reject',feedback})`。反馈至少 12 字符，应具体解释验收依据或缺陷。approve 在核对原文件哈希后才应用声明写入，reject 不应用文件；模型不能自批。原生 MCP 对 accept 的破坏性操作审批继续生效，受限 client 遇到需要审批时拒绝，不能换入口绕过。

本地任务只传明确选择且不含凭据的内容；不发送整个仓库、环境变量、私密配置或原始聊天记录。输入最长 2400 字符，额外指令最长 400 字符；分类提供 labels，字段提取提供 fields。任务类型为 `summarize/rewrite/translate/classify/extract_json/code_explain/code_draft`。风险字段由 GPT 填写。不要把大文件切成许多缺少上下文的小任务来追求本地调用次数。

公开 Windows alpha 要求用户已启动 Ollama 并准备好 qwen3:8b；服务不可用时报告阻塞，不猜测程序路径或执行项目启动脚本。固定回环地址。原纯文本 `local_ai_task` 至多两次实际生成，状态 `local_completed_review_required` 仅表示格式检查通过。把 output 视为不可信草稿，阅读其内容、核对输入和用户要求后，用返回的 taskId/candidateHash 调用 `local_ai_review`，写出具体依据。这个旧纯文本工具不会执行代码或应用文件；需要项目文本/数据落盘时走上述受限 agent，普通代码实现走 GoFlow。

有字数限制时，审核与报告应引用返回的 `outputMetrics` 中对应文本字段的确定计数：`unicodeCodePoints` 按 Unicode code point 计数，`utf16CodeUnits` 按 JavaScript 字符串长度计数，两者都包含标点、空格和换行。通常中文摘要使用 `unicodeCodePoints`，它不等于可视字形数量；用户指定其他计数规则时应按指定规则核实。不要凭心算或模型自报字数下结论。若旧运行时未返回统计，用确定性代码核对实际候选正文。统计不替代内容审核，不改变候选 hash，也不改写历史请求或审核记录。

`needs_goflow` 或审核拒绝时，先判断任务是否适合 Go 编程流程。可以调用 `local_ai_goflow_plan`，传真实项目目录和不含私密内容的简短摘要。该工具只检查和记录原 GoFlow 路由，不调用云模型。只有原用户任务已授权的明确代码工作，才由 GPT 继续原 GoFlow submit/resume；只有原服务确实返回 queued 和任务ID才报告已排队。服务禁用或缺失时报告阻断、保留原有队列，不经备用路径发请求；缺失登录和额度未知按原服务实际返回处理，不能切换其它付费接口。非代码任务可由当前 GPT 在原范围完成。

## 本聊天工具目录尚未刷新

使用同一插件的本地 MCP 客户端，参数从 stdin 输入 JSON，每次只调用一个允许工具。不要直接向其它模型 API 发请求：

```powershell
$localClient = Join-Path $env:USERPROFILE '.codex\plugins\local-ai-goflow\client.mjs'
'{}' | node $localClient local_ai_status
$localTask = @{projectDirectory=(Get-Location).Path;kind='summarize';text='这里是已明确选择的短文本';risk='low'}
$localTask | ConvertTo-Json -Compress | node $localClient local_ai_task
```

不要因为工具目录未刷新而另开一个产生模型消耗的 Codex 会话。插件安装后新聊天会加载工具；当前聊天的此客户端可作等价调用。客户端不绕过插件或服务禁用；不应在禁用时使用备用路径继续推理。

## 记录

`local_ai_metrics` 统计原纯文本通道的实际任务、请求、失败和审核；不要把它当新增 agent 的全部统计。纯文本日志只含元数据与候选哈希。新增 agent 的选定文件快照、候选与命令证据保存在本机私有 `state`，供真实审核与恢复读取，不提交 GitHub。`state` 位于克隆仓库根目录，已被 git 忽略；保留安装来源目录，插件包装只引用该目录。Go 额度仍由原 GoFlow 查询，ChatGPT/Codex 协调成本另计；本地 token 数不等于已经节省的 API 账单。
