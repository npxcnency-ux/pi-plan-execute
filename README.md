# plan-execute

为 pi 加一套「贵模型规划 + 廉价模型执行」的双阶段工作流。

> Plan with Opus, execute with Sonnet/DeepSeek — 把决策留给最强模型，把体力活外包给便宜模型。

## 核心理念

| 阶段 | 角色 | 默认模型 | 思考等级 | 工具 |
|------|------|---------|---------|------|
| **Plan** | 架构师 | Opus 4.7 [1m] | high (anthropic) / off (kpi) | 只读 + submit_plan |
| **Exec** | 执行者 | Sonnet 4.6 [1m] | low | 全工具 + 任务管理 |

Planner 分析、拆解、和你多轮打磨计划，最终写到 `.plans/<name>/`；Executor 在新 session 中读 `HANDOFF.md` 独立执行，不带 plan 阶段的对话上下文。

## 工作流

```
/plan opus "需求"
  │
  ├── Phase 1: 草案讨论（多轮）
  │   Opus 输出 Markdown 草案 → 不调 submit_plan
  │   你提修改意见 → Opus 重出草案
  │   ...直到你说 "OK / 提交 / submit"
  │
  ├── Phase 2: 落盘
  │   Opus 调 submit_plan → .plans/<name>/HANDOFF.md + tasks.jsonl
  │
  ├── /plan exec [model]
  │   写入 .exec-pending.json → ctx.newSession() 创建新 session
  │
  ├── Phase 3: 执行
  │   新 session 自动切到 Sonnet/DS + 全工具
  │   Executor 按 task 顺序执行 → 调 update_task 标记进度
  │   无依赖 task 用 subagent worker 并行
  │
  └── 完成
      弹菜单：切回主会话 / 留下来验证（用 /plan back 切回）
```

## 命令

```
/plan [model] [prompt]   进入规划模式
/plan exec [model]       执行当前计划（创建新 session）
/plan resume             续接未完成的计划
/plan status             查看当前计划进度
/plan back               切回主会话（执行 session 中可用）
/plan exit               退出规划模式
/plans [filter]          列出所有计划（filter: in-progress|done|abandoned）
/todos                   显示当前 task 列表
Ctrl+Alt+P               快捷键切换规划模式
```

### 模型简写

| 简写 | 模型 |
|------|------|
| `opus` / `op` / `opus47` | aws-claude-opus-4-7[1m] |
| `opus46` | aws-claude-opus-4-6[1m] |
| `sonnet` / `s` | aws-claude-sonnet-4-6[1m] |
| `haiku` | aws-claude-haiku-4-5 |
| `ds` | kivy-deepseek-v4-pro[1m] |
| `kimi` | kivy-kimi-k2_5 |
| `qwen` | kivy-qwen3.7-max |
| `minimax` | kivy-minimax-m2_5 |

## 使用示例

### 完整流程

```
/plan opus "实现用户认证模块，JWT + refresh token"

[Opus 输出草案 Markdown，问你要不要调整]

不要 JWT，改用 session-based 认证

[Opus 重出草案]

OK 提交

[Opus 调 submit_plan，HANDOFF.md 落盘]

/plan exec
[默认 Sonnet 4.6 执行，新 session]

[执行完毕 → 弹菜单]

切回主会话
```

### 直接指定模型

```
/plan opus "..."          规划用 Opus
/plan exec ds             执行用 DeepSeek
/plan exec opus           执行也用 Opus（成本高但可靠）
```

### 续接

```
/plan resume              选择要续接的计划，再选模型执行
/plan exec                内存里有 plan 直接执行；否则从磁盘 in-progress 中选
```

## 文件结构

```
项目根/
└── .plans/
    ├── plans.jsonl                 # 计划注册表
    ├── .exec-pending.json          # plan→exec 跨 session 握手（短暂）
    └── <plan-name>/
        ├── HANDOFF.md              # executor 的自包含启动 prompt
        └── tasks.jsonl             # 任务列表 + 状态 + notes
```

### tasks.jsonl 格式

```jsonl
{"_type":"meta","title":"...","plan_name":"...","created_at":"..."}
{"id":"1","description":"...","status":"pending","depends_on":[],"created_at":"..."}
{"id":"2","description":"...","status":"pending","depends_on":["1"],"created_at":"..."}
```

| status | 含义 |
|--------|------|
| `pending` | 待执行 |
| `done` | 完成 |
| `skipped` | 跳过 |
| `blocked` | 阻塞，等待用户指示 |
| `deferred` | 执行中发现的后续任务 |

## 状态栏

| 场景 | 左下角显示 |
|------|-----------|
| 进入 plan 模式但还在草案讨论 | `📝 plan — 待 submit_plan` |
| plan 已提交，未执行 | `📝 plan 0/N` |
| 执行中 | `📋 exec X/N` |
| 仅附加 plan（pi 重启后自动加载）| `📋 X/N`（灰色）|

## 关键设计

### 三阶段规划（草案 → 修订 → 提交）

planner prompt 强制 Opus 第一轮**只输出 Markdown 草案，不调 submit_plan**。等用户回复"OK / 提交"才调用 submit_plan 落盘。这样可以多轮打磨计划。

### update_task / add_task 读盘+写盘

subagent worker 是独立 pi 子进程，子进程的内存 state 是空的。如果 tool 依赖内存 state 就会失败。改成每次直接读 `tasks.jsonl` → 修改 → 写回，进程间天然安全。

### 跨 session 握手

```
主 session                          新 exec session
  │                                  │
  │ writeExecPending({               │
  │   planDir, parentSession,        │
  │   kickoff,                       │
  │   config                         │
  │ })                               │
  │                                  │
  │ ctx.newSession({withSession})    │
  │   ↓                              │
  │                                  │ session_start 触发
  │                                  │   readAndClearExecPending()
  │                                  │   enterExecMode()
  │                                  │ withSession 回调:
  │                                  │   newCtx.sendUserMessage(kickoff)
  │                                  │
```

### thinking level 自动适配

| Provider | plan thinking | exec thinking |
|----------|--------------|---------------|
| anthropic | `high` | `low` |
| kpi / 其他 | `off` | `off` |

kpi 网关不支持 reasoning 参数（会返回 400），自动降级。

### 阻塞处理

执行中遇到 `update_task(blocked)` 时，agent_end 弹菜单：

| 选项 | 行为 |
|------|------|
| 跳过此任务 | task → skipped，继续下一项 |
| 提供补充说明 | task → pending + 注入新指令重试 |
| 切回主会话重新规划 | 提示用户运行 `/plan back` |
| 中止执行 | 退出 exec 模式，恢复原模型 |

### 完成菜单

```
计划执行完成，下一步?
  • 切回主会话                                      ← 自动 switchSession
  • 留在当前会话继续验证 (之后用 /plan back 切回)
```

## 文件清单

```
plan-execute/
├── package.json              # pi manifest
├── README.md                 # 本文档
├── index.ts                  # 入口（commands/tools/events）
├── constants.ts              # 模型别名 + 工具集
├── types.ts                  # TypeScript 类型
├── plan-file.ts              # .plans/ 文件读写
├── phase-transitions.ts      # 模型/工具切换
└── prompts.ts                # plan/exec 阶段注入 prompt
```

## 已知限制 / 设计妥协

| 限制 | 缓解 |
|------|------|
| `agent_end` 事件 ctx 不带 newSession/switchSession | 改为提示用户运行 `/plan exec` / `/plan back` |
| subagent worker 子进程不一定主动调 update_task | exec prompt 强制要求 worker 完成后调用 |
| kpi 模型不支持 reasoning 参数 | 模型定义 reasoning: false，thinking 自动 off |
| 多个 in-progress 计划时不会自动加载 | 用 `/plan resume` 或 `/plan exec` 弹菜单选 |
| executor 可能误调 git-commit / questionnaire 等 skill | exec prompt 明确禁止调 skill |

## 与其他扩展的关系

| 扩展 | 区别 |
|------|------|
| 官方 `handoff.ts` | 上下文压缩到新 prompt，不切模型 |
| `@danchamorro/pi-handoff-agent` | 导出 session 给外部 agent，不切模型 |
| `dazuiba/handoff` (Python) | 后台 spawn CLI，跨 agent 派发，多任务并行 |
| `@dreki-gg/pi-plan-mode` | 同样思路，但绑定 Opus+GPT-5.5 |
| **plan-execute** (本扩展) | **支持 kPI 模型池 + 三阶段规划 + 跨 session 自动握手** |

## 调试

| 文件 | 用途 |
|------|------|
| `.plans/<name>/tasks.jsonl` | 手动编辑可修复 task 状态 |
| `.plans/plans.jsonl` | 注册表，删除对应行即"删除计划" |
| `.plans/.exec-pending.json` | 跨 session 握手文件，正常情况自动清除 |
| pi session entries 中的 `plan-execute-state` | 同 session 内的状态持久化 |

### 删除计划

没有 `/plan delete` 命令，手动处理：

```bash
# 删单个计划
rm -rf .plans/<plan-name>/
# 同时从 .plans/plans.jsonl 删掉对应行

# 清空所有计划
rm -rf .plans/
```

### 常见问题

**Q: `/plan exec` 后没反应？**
A: 检查命令选完模型有没有真的回车。pickExecModel 用最后一对括号匹配 alias，`(kPI) (sonnet)` 这种格式取最后的 `sonnet`。

**Q: 进度 widget 不更新？**
A: subagent worker 调 update_task 在子进程，主进程内存 state 不同步。`turn_end` 事件每轮从磁盘重读 tasks.jsonl 刷新 widget。

**Q: 切到 exec session 但没有 `📋 exec X/N`？**
A: exec-pending 没读到。检查 `.plans/.exec-pending.json` 是否存在（如果还在说明 session_start 没触发或读取失败）。

**Q: 执行用了错误的模型？**
A: 输入参数优先：`/plan exec ds` 直接锁定 DS，跳过菜单。
