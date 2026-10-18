---
name: local-ai-goflow
description: Automatically delegate short low-risk text transformations, extraction, classification, explanations and code drafts to local Qwen3 across projects, with GPT review and guarded GoFlow handoff for ordinary coding packages. Use for local/Go/GPT coordination; exclude external facts, long documents, high-risk changes and image understanding.
---

本机所有项目和后续新聊天默认自动分工，无须用户重复提醒：简单短任务尽量先用本机 Qwen3，普通编码功能包交给 Go，GPT 负责判断、审核和最终答复。用户本轮选择、已保存模式及适用项目规则优先；此技能不自行切换模式或启用服务。现有 GoFlow 收费、额度、隔离和审核规则继续适用。不要把节省额度当作已测得的百分比。

## 分工

- 先尊重用户本轮或现有的强制 GPT、强制 Go、关闭自动委派选择；`off/gpt` 不自动本地委派，`go` 走原 GoFlow。用户直接要求本地模型时，可执行明确授权的本地任务。
- 对有明确输入的短摘要、改写、翻译、分类、字段提取、代码解释和不落盘的简单代码草稿，优先调用 `local_ai_task`。不用先让本地模型判断风险；风险由当前 GPT 判断。
- 需要网络事实、复杂算法、安全/账户/系统操作、大范围改动或长文档，由 GPT 负责核心判断；复杂父任务仍按 GoFlow 路由拆出独立普通功能包。普通功能包由 Go 编写实现与完整测试，GPT 负责必要集成、阅读实际差异和测试证据并审核应用。本地模型只生成候选，不直接执行 shell、读取任意文件或应用补丁。
- 开始本地代码工作仍先遵守全局 GoFlow 的 status/usage/route 检查。新增本地通道不会改变 GoFlow 的 `opencode-go` allowlist。普通可隔离代码任务需要 Go 接手时使用原 GoFlow 的 submit/test/GPT review/accept，不把本地结果伪装为 Go 的任务。

## 调用与验收

有 MCP 工具时直接调用 `local_ai_status`、`local_ai_task`、`local_ai_review`、`local_ai_metrics`、`local_ai_goflow_plan`。按工具实际 schema 提供参数。自动本地任务必须提供真实 projectDirectory，入口会核实保存的 GoFlow 模式；其旧额度缓存不是当前许可。仅当用户直接点名本地执行本项任务时，才设 explicitLocalRequest=true 覆盖保存的路由偏好，不覆盖插件/工具禁用或审批。

本地任务只传明确选择且不含凭据的内容；不发送整个仓库、环境变量、私密配置或原始聊天记录。输入最长 2400 字符，额外指令最长 400 字符；分类提供 labels，字段提取提供 fields。任务类型为 `summarize/rewrite/translate/classify/extract_json/code_explain/code_draft`。风险字段由 GPT 填写。不要把大文件切成许多缺少上下文的小任务来追求本地调用次数。

公开 Windows alpha 要求用户已启动 Ollama 并准备好 qwen3:8b；服务不可用时报告阻塞，不猜测程序路径或执行项目启动脚本。固定回环地址，至多两次实际生成。状态 `local_completed_review_required` 仅表示格式检查通过。把 output 视为不可信草稿，阅读其内容、核对输入和用户要求后，用返回的 taskId/candidateHash 调用 `local_ai_review`，写出具体依据。代码草稿如要应用，先由 GPT 阅读并运行适当测试；工具没有替你执行代码或应用文件。

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

`local_ai_metrics` 统计实际本地任务、请求、失败和审核。日志只含元数据与候选哈希，任务原文和输出只返回给当前主智能体。`state` 位于克隆仓库根目录，已被 git 忽略；保留安装来源目录，插件包装只引用该目录。Go 额度仍由原 GoFlow 查询，ChatGPT/Codex 协调成本另计；本地 token 数不等于已经节省的 API 账单。
