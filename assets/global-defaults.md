<!-- LOCAL_AI_GOFLOW BEGIN v0.1.0 -->
## 本机全局默认：本地 Qwen3、Go 与 GPT 自动分工

本机所有项目和后续新聊天默认自动采用此分工，无须用户每次提醒。自动模式下，有明确输入的短摘要、改写、翻译、分类、字段提取、代码解释和不落盘的短代码草稿优先使用 local-ai-goflow 插件技能；GPT 阅读候选结果并记录具体审核依据。普通编码任务按完整且可隔离的功能包交给 Go 编写实现和测试，继续遵守 GoFlow 的 status/usage/route、快照隔离、收费保护、修复预算与 GPT review/accept；复杂或高风险工作由当前 GPT 负责核心判断并拆出适合 Go 的普通功能包。

用户已授权本地 Qwen 通过受限工具完成简单项目文本和数据任务：GPT 按需求先选定项目相对路径的 readFiles、writeFiles 与固定 commands，再调用 local_ai_agent_run；Qwen 真实读取所选文件、生成快照候选并执行受信检查。GPT 用 local_ai_agent_task 阅读实际候选、命令 exitCode 及 candidateHash 后，通过 local_ai_agent_accept 审核，核对原文件哈希后才保存。命令仅支持 text_stats、json_validate、csv_stats、javascript_check、node_version；不开放任意 shell、全盘读取或模型自批。自定义命令与项目测试继续由 GPT/Go 原执行链完成，普通编码仍交 Go。旧 local_ai_task 保持纯文本候选通道。

GoFlow 的 `files` 只列已经存在的明确输入；现有可编辑文件同时列入 `files` 和 `editableFiles`，待新建文件只列入 `editableFiles`。完全新建且不需要已有输入的功能包使用 `files: []`，例如 `editableFiles: ["tags.mjs", "tags.test.mjs"]`，不要为提交创建空占位。有字数限制时，GPT 引用 `outputMetrics` 中对应字段的 `unicodeCodePoints` 或 `utf16CodeUnits` 确定计数，两者均含标点、空格和换行；按用户约定选择计数规则，不凭模型自报或心算。统计不替代内容审核，也不改写既有候选与历史审核。

用户本轮明确选择、已保存的强制 GPT/强制 Go/关闭自动委派模式和适用项目规则优先；本块不修改模式或覆盖权限。入口先核实保存模式，不能绕过插件禁用和工具审批。只有用户直接点名本地执行本项任务时，才允许 explicitLocalRequest 覆盖路由偏好，项目无效始终拒绝。Go 额度阻塞不等于本地推理不可用；缺失登录、额度未知或服务故障不代表 Go 可执行。保留实际返回的同一排队任务，服务未返回 queued 及 taskId 时不得宣称已排队。只记录真实请求、执行和审核，不承诺节省百分比；agent 快照和候选保留在私有 state，不公开到 GitHub。
<!-- LOCAL_AI_GOFLOW END v0.1.0 -->
