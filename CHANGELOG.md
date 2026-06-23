# Changelog

记录 plan-execute 扩展的 bug 与修复。最新在上。

## 2026-06-23

### Fixed
- **`tasks.jsonl` 跨进程读半写**：`fs.writeFileSync` 是 `open/trunc → write* → close`，跨进程不原子。多 worker 并行执行时，`turn_end` 刷 widget 或兄弟 worker 调 `update_task` 可能读到空文件 / 截断 JSON。改用 atomic rename（写 `tasks.jsonl.<pid>.tmp` → `rename` 到目标），POSIX `rename` 在同 fs 内原子。
  - 注意：仅解决"读半写"，**未解决两个 worker 同时 read-modify-write 时的丢更新**。个人单机场景窗口极窄、后果可恢复（下次 turn_end 重读），暂不上 `proper-lockfile`。
- **session 文件被 `plan-execute-state` entry 撑大**：`persistState` 每轮无条件 `appendEntry`，session 文件 append-only，几个月下来旧条目堆积。加幂等守卫：用 `JSON.stringify(snapshot)` 比对 `lastPersistedKey`，状态未变直接 return。
- **`.exec-pending.json` 异常残留导致下次 session 被误恢复**：`launchExecSession` 取消 / 抛错时 pending 文件仍在盘上，下次任意 `session_start` 都会读到它并强行进 exec 模式。修复：1) `readAndClearExecPending` 增加 5min TTL，过期直接丢弃；2) `launchExecSession` 的 cancelled 分支和 catch 分支都调 `clearExecPending`。
- **`agent_end` 阻塞菜单只处理 `blocked[0]`**：多个 task 同时 blocked 时，剩余的要等下一轮 agent_end 才弹菜单 —— 中间 executor 空跑一轮浪费 token。改为 while 循环处理所有 blocked，循环内累积跳过数与重试说明，结束后一次性 `sendUserMessage` 通知 executor 继续。
  - 边界：用户取消"补充说明"编辑器 → 任务保持 blocked，跳出循环，不发 followUp（避免假装"已跳过"误导 executor）。
  - 边界：循环中选"切回主会话"或"中止执行" → 立即退出循环，剩余 blocked 保留状态等下次处理。
- **`buildExecPrompt` 推荐的"next task"不看 `depends_on`**：原本 `tasks.find(t => t.status === "pending")` 返回第一个 pending，可能其依赖未完成。改为先建 `doneSet`（done + skipped）再 filter `depends_on.every(d => doneSet.has(d))`，找真正可立即开干的 task。
- **`session_start` 用 `Object.assign(state, saved.data)` 全量恢复**：`userExited` 等本会话内临时标志会跨重启复活，历史上导致过 `/plan status` 看不见磁盘上的计划。改为白名单字段拷贝，只恢复跨会话有意义的 7 个字段，明确丢弃 `userExited` 和 `executionStartIdx`（后者在新 session 里索引会变，留着无意义）。

## 2026-06-16

### Fixed
- **`/plan resume → 重新规划` 崩溃**：`Cannot read properties of undefined (reading 'title')`。`enterPlanMode` 内部把 `state.plan` 清空了，后续读 `state.plan.title` 崩。提前用局部变量 `savedTitle/savedDir/savedPlanName` 缓存。
- **exec session 报 `messages: at least one message is required` (400)**：`context` 事件过滤器用 `executionStartIdx` 索引过滤，新 session 重置索引导致全部消息被过滤。删掉索引过滤逻辑，只按 `customType` 过滤。
- **`/plan exec` 选模型后没反应**：`pickExecModel` 用正则 `/\((\w+)\)/` 提取 alias，label 形如 `"Sonnet 4.6 (kPI) (sonnet)"` 有两对括号，匹配到第一对 `kPI` → 找不到模型 → 静默 return。改用最后一对括号匹配。
- **`/plan exec` 找不到 in-progress 计划报错**：当内存里没 plan 时直接报"没有活跃的计划"。改成主动从磁盘扫描 in-progress 计划，唯一时自动 attach，多个时弹菜单。
- **`/plan status` / `/todos` 看不到磁盘上的计划**：之前 `/plan exit` 设了 `userExited` 阻止 auto-load。新增 `attachInProgressPlan` 辅助函数，这两个查询命令忽略 userExited 标志。
- **退出 plan 模式后状态栏还显示进度**：`exitToNormal` 没清 `state.plan`。`/plan exit` 时显式清 `state.plan / state.planDir / state.parentSession`。
- **subagent worker 调 `update_task` 子进程内存为空**：worker 是独立 pi 进程，子进程的 `state.plan` 永远为 undefined。tool 改成读盘+写盘，`findInProgressPlans(ctx.cwd)` 自动定位计划目录。
- **kPI 模型返回 `400 (no body)`**：`model.reasoning: true` 即使 thinking=off 时，pi 仍会在请求体加 `reasoning: { effort: "none" }`，kPI 网关不认。把 kivy-* 模型全改成 `reasoning: false`。
- **plan 阶段 thinking=high 触发 kPI 404**：openai-responses 端点不支持 reasoning effort 参数。`enterPlanMode` 按 provider 自动决定 thinking level：anthropic 用 high，其他强制 off。
- **`agent_end` 事件 ctx 不带 newSession**：在 plan 完成后弹菜单调 `launchExecSession` 报 `ctx.newSession is not a function`。`agent_end` 拿到的是 `ExtensionContext` 不是 `ExtensionCommandContext`。改成只通知用户运行 `/plan exec`。
- **`handleReturn` 报 `switchSession is not a function`**：同上。改为提示用户运行 `/plan back`。
- **prompts.ts 模板字符串里有反引号导致 ParseError**：内层用了 `` `update_task(...)` ``，外层 template literal 被截断。去掉内层反引号。
- **EXEC_TOOLS 缺 subagent**：执行阶段无法用 subagent worker 并行加速。加进工具集。
- **kpi-extension 的 `kivy-gemma-4-31b-it` 返回 404**：kPI 网关没此模型。删除。

### Added
- **三阶段规划工作流**：planner prompt 强制「草案 → 修订 → 提交」三步，避免第一轮就调 submit_plan，给用户多轮打磨机会。
- **`/plan back` 命令**：从 exec session 切回主 session（`state.parentSession`）。
- **`/plan exec` 自动从磁盘加载**：1 个 in-progress 计划自动 attach，多个时弹菜单。
- **`/plans` 命令**：列出所有计划（含已完成），支持 `/plans done` / `/plans in-progress` 等过滤。
- **状态栏「待 submit_plan」提示**：进入 plan 模式但还没 submit 时，左下角显示 `📝 plan — 待 submit_plan`。
- **完成后菜单**：执行完成弹菜单选「切回主会话 / 留下来验证」，留下时提示用 `/plan back`。
- **kickoff 推迟发送**：通过 `withSession` 回调里 `await newCtx.sendUserMessage(kickoff)`，避免新 session 初始化时 messages 为空。
- **EXEC prompt 强化**：明确禁止调 skill / git commit / install 等副作用操作，避免 executor 误触发 git-commit-helper。
- **subagent 并行加速 prompt**：明确要求派发给 worker 的 task 描述末尾要让 worker 自己调 `update_task` 标记进度。

### Changed
- **执行模型默认改为 Sonnet 4.6 [1m]**：原来是 DeepSeek V4 Pro。Sonnet 在工具调用稳定性上更可靠。
- **DS 模型 ID 改为 `kivy-deepseek-v4-pro[1m]`**：1M 上下文版本，更适合长 HANDOFF.md。
- **plan 模式 thinking 默认 high**：从 medium 升级，更适合复杂规划。
- **`update_task` / `add_task` 改为读盘+写盘**：不再依赖内存 state，跨进程安全。
- **`turn_end` 事件每轮重读 tasks.jsonl**：subagent worker 写盘后，主进程 widget 实时刷新。
- **`pickExecModel` alias 正则用最后一对括号**：兼容 label 含多对括号的情况。

## 设计决策记录

### 为什么 exec session 单独开新 session 而不是同 session 切模式
- 上下文隔离最干净，executor 看不到 plan 阶段的对话
- token 成本只算执行那部分
- 主 session 保留可随时回（`/plan back`）

### 为什么用文件系统做 plan 持久化而非内存
- 跨 session 共享（plan 在主 session 创建，exec 在新 session 读）
- 跨 pi 进程重启也能续接
- subagent 子进程也能读写（绕开内存隔离）

### 为什么 `state` 跨 session 共享但 plan 数据走文件
- `state` 是扩展闭包变量，进程级共享
- session 切换不影响 state（pi 不重置扩展状态）
- 但 plan 数据要跨进程（subagent）和跨重启，所以走文件

## 已知踩坑（避坑指南）

| 现象 | 原因 | 不要这样做 |
|------|------|----------|
| `ctx.newSession is not a function` | 在 event handler 里调 | 只在 slash command handler 调 |
| `messages: at least one message is required` | context filter 索引过滤新 session | 不要用 idx 过滤跨 session 的消息 |
| 模型返回 400 (no body) | model.reasoning: true 但端点不支持 | reasoning: false 关闭参数 |
| widget 不更新 | 依赖内存 state，subagent 子进程没改到 | tool 实现走文件 I/O |
| `/plan exec` 静默无响应 | label 多对括号正则匹配错位 | match 用 `g` flag 取最后一项 |
| 模板字符串 ParseError | template literal 内层有反引号 | 内层用普通引号或转义 |
