/**
 * Plan-Execute Extension
 *
 * Two-phase workflow: Plan with a SOTA model, execute with a cheap model.
 *
 * Commands:
 *   /plan [model] [prompt]   Enter plan mode (model optional, e.g. /plan opus "做认证")
 *   /plan exec [model]       Execute current plan (model optional, e.g. /plan exec ds)
 *   /plan resume             Resume an in-progress plan
 *   /plan status             Show current plan progress
 *   /plan exit               Exit plan mode
 *   /plan back               Switch back to the parent session
 *   /todos                   Show task progress
 *   Ctrl+Alt+P               Toggle plan mode
 *
 * Models (short aliases): opus/op, opus46, sonnet/s, ds, kimi, qwen, minimax
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Key } from "@earendil-works/pi-tui";
import {
	PLAN_TOOLS,
	EXEC_TOOLS,
	PLAN_MODEL_OPTIONS,
	EXEC_MODEL_OPTIONS,
	PLAN_THINKING,
	EXEC_THINKING,
	resolveModelAlias,
	type ModelDef,
} from "./constants.ts";
import type { PlanExecuteState, Task } from "./types.ts";
import {
	submitPlan,
	readTasksJsonl,
	writeTasksJsonl,
	readHandoff,
	readPlansRegistry,
	writeExecPending,
	readAndClearExecPending,
	clearExecPending,
	findInProgressPlans,
	upsertPlanRegistry,
	planDir,
} from "./plan-file.ts";
import { enterPlanMode, enterExecMode, exitToNormal } from "./phase-transitions.ts";
import { buildPlanModePrompt, buildExecPrompt } from "./prompts.ts";

export default function planExecute(pi: ExtensionAPI): void {
	// ── State ─────────────────────────────────────────────────────────────────
	const state: PlanExecuteState = {
		planEnabled: false,
		executing: false,
	};

	// ── Helpers ───────────────────────────────────────────────────────────────

	function updateUI(ctx: any): void {
		if (!state.plan) {
			ctx.ui.setWidget("plan-todos", undefined);
			if (state.planEnabled) {
				ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "📝 plan — 待 submit_plan"));
			} else if (state.executing) {
				ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", "📋 exec"));
			} else {
				ctx.ui.setStatus("plan-mode", undefined);
			}
			return;
		}

		const done = state.plan.tasks.filter((t) => t.status === "done" || t.status === "skipped").length;
		const total = state.plan.tasks.length;
		const progress = `${done}/${total}`;

		if (state.executing) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 exec ${progress}`));
		} else if (state.planEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", `📝 plan ${progress}`));
		} else {
			// Plan attached but not actively in plan/exec mode: show progress only
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("muted", `📋 ${progress}`));
		}

		// Always show widget when a plan is attached (regardless of mode)
		if (state.plan.tasks.length > 0) {
			const icon: Record<string, string> = { pending: "○", done: "✓", skipped: "⊘", blocked: "✗", deferred: "⏸" };
			const lines = state.plan.tasks.map((t) => {
				const mark = icon[t.status] ?? "○";
				if (t.status === "done" || t.status === "skipped") {
					return ctx.ui.theme.fg("muted", `${mark} ${t.description}`);
				}
				return `${ctx.ui.theme.fg("success", mark)} ${t.description}`;
			});
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	let lastPersistedKey = "";
	function persistState(ctx: any): void {
		const snapshot = {
			planEnabled: state.planEnabled,
			executing: state.executing,
			planDir: state.planDir,
			plan: state.plan,
			parentSession: state.parentSession,
			executionStartIdx: state.executionStartIdx,
			previousModel: state.previousModel,
			previousThinking: state.previousThinking,
		};
		// Skip if nothing changed since last persist — session file is append-only,
		// avoid duplicate entries piling up turn after turn.
		const key = JSON.stringify(snapshot);
		if (key === lastPersistedKey) return;
		lastPersistedKey = key;
		pi.appendEntry("plan-execute-state", snapshot);
	}

	async function pickPlanModel(ctx: any): Promise<ModelDef | null | undefined> {
		// undefined = cancelled, null = use current model
		const labels = PLAN_MODEL_OPTIONS.map((o) => o.label);
		labels.push("取消");
		const choice = await ctx.ui.select("选择规划模型:", labels);
		if (!choice || choice === "取消") return undefined;
		return PLAN_MODEL_OPTIONS.find((o) => o.label === choice)?.model ?? null;
	}

	async function pickExecModel(ctx: any): Promise<ModelDef | undefined> {
		const labels = EXEC_MODEL_OPTIONS.map((o) => `${o.label} (${o.alias})`);
		labels.push("取消");
		const choice = await ctx.ui.select("选择执行模型:", labels);
		if (!choice || choice === "取消") return undefined;
		// label 里可能有多对括号（如 "Sonnet 4.6 (kPI) (sonnet)"），取最后一对作为 alias
		const matches = choice.match(/\((\w+)\)/g);
		const alias = matches?.[matches.length - 1]?.slice(1, -1);
		return EXEC_MODEL_OPTIONS.find((o) => o.alias === alias)?.model;
	}

	// ── Flag ──────────────────────────────────────────────────────────────────
	pi.registerFlag("plan", {
		description: "Start in plan mode",
		type: "boolean",
		default: false,
	});

	// ── Tools ─────────────────────────────────────────────────────────────────

	// submit_plan — called by planner to save the plan
	pi.registerTool({
		name: "submit_plan",
		label: "Submit Plan",
		description: "Submit a plan with tasks and handoff prompt. Creates .plans/<name>/HANDOFF.md and tasks.jsonl.",
		parameters: Type.Object({
			name: Type.String({ description: "Plan name in kebab-case (e.g. user-auth-module)" }),
			title: Type.String({ description: "Human-readable plan title" }),
			tasks: Type.Array(
				Type.Object({
					id: Type.String({ description: "Task ID (numeric string, e.g. '1')" }),
					description: Type.String({ description: "Task description" }),
					depends_on: Type.Optional(Type.Array(Type.String(), { description: "IDs of tasks this depends on" })),
				}),
				{ description: "Ordered list of tasks" },
			),
			handoff: Type.String({ description: "Self-contained HANDOFF.md content for the executor" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const now = new Date().toISOString();
			const tasks: Task[] = params.tasks.map((t) => ({
				id: t.id,
				description: t.description,
				status: "pending" as const,
				depends_on: t.depends_on ?? [],
				created_at: now,
			}));

			const dir = submitPlan(ctx.cwd, params.name, params.title, tasks, params.handoff);
			state.planDir = dir;
			state.plan = {
				title: params.title,
				planName: params.name,
				handoff: params.handoff,
				tasks,
			};

			return {
				content: [{ type: "text" as const, text: `计划已保存到 ${dir}\n任务数: ${tasks.length}` }],
			};
		},
	});

	// update_task — called by executor to mark tasks
	pi.registerTool({
		name: "update_task",
		label: "Update Task",
		description: "Mark a task as done, skipped, blocked, or deferred.",
		parameters: Type.Object({
			id: Type.String({ description: "Task ID" }),
			status: Type.Union(
				[
					Type.Literal("done"),
					Type.Literal("skipped"),
					Type.Literal("blocked"),
					Type.Literal("deferred"),
				],
				{ description: "New task status" },
			),
			notes: Type.Optional(Type.String({ description: "Brief notes (what was done, or why blocked)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// Read from disk — supports subagent child processes that don't
			// have the parent's in-memory plan state.
			let dir = state.planDir;
			if (!dir) {
				const inProgress = findInProgressPlans(ctx.cwd);
				if (inProgress.length === 1) dir = planDir(ctx.cwd, inProgress[0].name);
			}
			if (!dir) {
				return { content: [{ type: "text" as const, text: "No active plan" }], isError: true };
			}

			const snapshot = readTasksJsonl(dir);
			if (!snapshot) {
				return { content: [{ type: "text" as const, text: `计划文件读取失败: ${dir}` }], isError: true };
			}

			const task = snapshot.tasks.find((t) => t.id === params.id);
			if (!task) {
				return { content: [{ type: "text" as const, text: `Task ${params.id} not found` }], isError: true };
			}

			task.status = params.status;
			task.updated_at = new Date().toISOString();
			if (params.notes) task.notes = params.notes;

			writeTasksJsonl(dir, snapshot.meta, snapshot.tasks);

			// Sync in-memory state if we have it
			if (state.plan && state.planDir === dir) {
				state.plan.tasks = snapshot.tasks;
			}

			const done = snapshot.tasks.filter((t) => t.status === "done" || t.status === "skipped").length;
			const total = snapshot.tasks.length;

			return {
				content: [{
					type: "text" as const,
					text: `Task ${params.id} → ${params.status}. 进度: ${done}/${total}`,
				}],
			};
		},
	});

	// add_task — called by executor when discovering additional work
	pi.registerTool({
		name: "add_task",
		label: "Add Task",
		description: "Capture a newly discovered task (deferred for later review).",
		parameters: Type.Object({
			description: Type.String({ description: "Task description" }),
			depends_on: Type.Optional(Type.Array(Type.String())),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			let dir = state.planDir;
			if (!dir) {
				const inProgress = findInProgressPlans(ctx.cwd);
				if (inProgress.length === 1) dir = planDir(ctx.cwd, inProgress[0].name);
			}
			if (!dir) {
				return { content: [{ type: "text" as const, text: "No active plan" }], isError: true };
			}

			const snapshot = readTasksJsonl(dir);
			if (!snapshot) {
				return { content: [{ type: "text" as const, text: `计划文件读取失败: ${dir}` }], isError: true };
			}

			const maxId = snapshot.tasks.reduce((max, t) => Math.max(max, parseInt(t.id) || 0), 0);
			const newId = String(maxId + 1);
			const newTask: Task = {
				id: newId,
				description: params.description,
				status: "deferred",
				depends_on: params.depends_on ?? [],
				created_at: new Date().toISOString(),
			};

			snapshot.tasks.push(newTask);
			writeTasksJsonl(dir, snapshot.meta, snapshot.tasks);

			if (state.plan && state.planDir === dir) {
				state.plan.tasks = snapshot.tasks;
			}

			return {
				content: [{ type: "text" as const, text: `已添加后续任务 ${newId}: ${params.description}` }],
			};
		},
	});

	// plan_status — read-only snapshot
	pi.registerTool({
		name: "plan_status",
		label: "Plan Status",
		description: "Get a read-only snapshot of the current plan progress.",
		parameters: Type.Object({}),
		async execute() {
			if (!state.plan) {
				return { content: [{ type: "text" as const, text: "No active plan" }] };
			}

			const icon: Record<string, string> = { pending: "○", done: "✓", skipped: "⊘", blocked: "✗", deferred: "⏸" };
			const lines = state.plan.tasks.map((t) => `${icon[t.status] ?? "○"} ${t.id}. ${t.description}${t.notes ? ` [${t.notes}]` : ""}`);
			const done = state.plan.tasks.filter((t) => t.status === "done" || t.status === "skipped").length;

			return {
				content: [{
					type: "text" as const,
					text: `${state.plan.title} (${done}/${state.plan.tasks.length})\n\n${lines.join("\n")}`,
				}],
			};
		},
	});

	// ── Commands ──────────────────────────────────────────────────────────────

	pi.registerCommand("plan", {
		description: [
			"Plan-execute workflow.",
			"Usage: /plan [model] [prompt] | /plan exec [model] | /plan resume | /plan status | /plan back | /plan exit",
			"Model aliases: opus/op, opus46, sonnet/s, ds, kimi, qwen",
		].join(" "),
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "";

			// ── /plan back — 切回主会话 ──
			if (sub === "back") {
				if (!state.parentSession) {
					ctx.ui.notify("没有记录到主会话路径，使用 /resume <session> 手动切回", "info");
					return;
				}
				const target = state.parentSession;
				try {
					await ctx.switchSession(target);
				} catch (err) {
					ctx.ui.notify(`切回主会话失败: ${err instanceof Error ? err.message : String(err)}`, "error");
				}
				return;
			}

			// ── /plan exit ──
			if (sub === "exit") {
				if (!state.planEnabled && !state.executing && !state.plan) {
					ctx.ui.notify("当前不在规划模式", "info");
					return;
				}
				await exitToNormal(state, pi, ctx);
				state.plan = undefined;
				state.planDir = undefined;
				state.parentSession = undefined;
				state.userExited = true;
				updateUI(ctx);
				persistState(ctx);
				ctx.ui.notify("已退出规划模式", "info");
				return;
			}

			// ── /plan status ──
			if (sub === "status") {
				attachInProgressPlan(ctx.cwd);
				if (!state.plan) {
					ctx.ui.notify("没有活跃的计划，使用 /plan 开始规划（多个 in-progress 时用 /plan resume）", "info");
					return;
				}
				const icon: Record<string, string> = { pending: "○", done: "✓", skipped: "⊘", blocked: "✗", deferred: "⏸" };
				const lines = state.plan.tasks.map(
					(t) => `${icon[t.status] ?? "○"} ${t.id}. ${t.description}${t.notes ? ` — ${t.notes}` : ""}`,
				);
				const done = state.plan.tasks.filter((t) => t.status === "done" || t.status === "skipped").length;
				ctx.ui.notify(`${state.plan.title} (${done}/${state.plan.tasks.length})\n\n${lines.join("\n")}`, "info");
				return;
			}

			// ── /plan resume ──
			if (sub === "resume") {
				const inProgress = findInProgressPlans(ctx.cwd);
				if (inProgress.length === 0) {
					ctx.ui.notify("没有进行中的计划", "info");
					return;
				}

				let planName: string;
				if (inProgress.length === 1) {
					planName = inProgress[0].name;
				} else {
					const options = inProgress.map((p) => `${p.name} — ${p.title}`);
					options.push("取消");
					const choice = await ctx.ui.select("续接哪个计划?", options);
					if (!choice || choice === "取消") return;
					planName = choice.split(" — ")[0];
				}

				const dir = planDir(ctx.cwd, planName);
				const snapshot = readTasksJsonl(dir);
				if (!snapshot) {
					ctx.ui.notify(`无法读取 ${dir}/tasks.jsonl`, "error");
					return;
				}

				state.plan = {
					title: snapshot.meta.title,
					planName: snapshot.meta.plan_name,
					handoff: readHandoff(dir),
					tasks: snapshot.tasks,
				};
				state.planDir = dir;

				const done = snapshot.tasks.filter((t) => t.status === "done" || t.status === "skipped").length;
				const pending = snapshot.tasks.filter((t) => t.status === "pending").length;

				const action = await ctx.ui.select(
					`续接 "${state.plan.title}" (${done}/${snapshot.tasks.length} 完成, ${pending} 待执行)`,
					["继续执行", "重新规划", "取消"],
				);

				if (!action || action === "取消") return;

				if (action === "重新规划") {
					// 先保存信息再进入规划模式（enterPlanMode 会清空 state.plan）
					const savedTitle = state.plan.title;
					const savedDir = dir;
					const savedPlanName = planName;
					const modelChoice = await pickPlanModel(ctx);
					if (modelChoice === undefined) return;
					await enterPlanMode(state, pi, ctx, modelChoice);
					pi.sendUserMessage(
						`已有计划 "${savedTitle}" 位于 ${savedDir}，请重新分析并使用 submit_plan 提交修订版本。保留计划名 "${savedPlanName}"。`,
					);
					updateUI(ctx);
					persistState(ctx);
					return;
				}

				// 继续执行 — pick exec model
				let execModel: ModelDef | undefined;
				const execAlias = parts[1] ? resolveModelAlias(parts[1]) : null;
				if (execAlias) {
					execModel = execAlias;
				} else {
					execModel = await pickExecModel(ctx);
					if (!execModel) return;
				}

				await launchExecSession(ctx, execModel, dir);
				return;
			}

			// ── /plan exec [model] ──
			if (sub === "exec") {
				// 如果内存里没有 plan，从磁盘加载 in-progress 计划
				if (!state.plan || !state.planDir) {
					const inProgress = findInProgressPlans(ctx.cwd);
					if (inProgress.length === 0) {
						ctx.ui.notify("没有进行中的计划，先使用 /plan 规划", "error");
						return;
					}

					let entry = inProgress[0];
					if (inProgress.length > 1) {
						const options = inProgress.map((p) => `${p.name} — ${p.title}`);
						options.push("取消");
						const choice = await ctx.ui.select("要执行哪个计划?", options);
						if (!choice || choice === "取消") return;
						const pickName = choice.split(" — ")[0];
						const found = inProgress.find((p) => p.name === pickName);
						if (!found) return;
						entry = found;
					}

					const dir = planDir(ctx.cwd, entry.name);
					const snapshot = readTasksJsonl(dir);
					if (!snapshot) {
						ctx.ui.notify(`无法读取 ${dir}/tasks.jsonl`, "error");
						return;
					}
					state.plan = {
						title: snapshot.meta.title,
						planName: snapshot.meta.plan_name,
						handoff: readHandoff(dir),
						tasks: snapshot.tasks,
					};
					state.planDir = dir;
					state.userExited = false;
				}

				let execModel: ModelDef | undefined;
				const aliasArg = parts[1] ? resolveModelAlias(parts[1]) : null;
				if (aliasArg) {
					execModel = aliasArg;
				} else {
					execModel = await pickExecModel(ctx);
					if (!execModel) return;
				}

				await launchExecSession(ctx, execModel, state.planDir!);
				return;
			}

			// ── /plan [model?] [prompt?] — enter plan mode ──
			if (state.planEnabled || state.executing) {
				// Toggle off
				await exitToNormal(state, pi, ctx);
				updateUI(ctx);
				persistState(ctx);
				return;
			}

			// Check if first arg is a model alias
			let planModel: ModelDef | null | undefined;
			let prompt = parts.join(" ");

			const aliasFromArg = parts[0] ? resolveModelAlias(parts[0]) : null;
			if (aliasFromArg) {
				planModel = aliasFromArg;
				prompt = parts.slice(1).join(" ");
			} else {
				// Show model picker
				planModel = await pickPlanModel(ctx);
				if (planModel === undefined) return; // cancelled
			}

			await enterPlanMode(state, pi, ctx, planModel);
			updateUI(ctx);
			persistState(ctx);

			if (prompt) pi.sendUserMessage(prompt);
		},
	});

	pi.registerCommand("plans", {
		description: "List all plans (in-progress and completed)",
		handler: async (args, ctx) => {
			const all = readPlansRegistry(ctx.cwd);
			if (all.length === 0) {
				ctx.ui.notify("还没有计划，使用 /plan 开始创建", "info");
				return;
			}

			const filter = (args ?? "").trim().toLowerCase();
			const filtered = filter
				? all.filter((p) => p.status === filter)
				: all;

			if (filtered.length === 0) {
				ctx.ui.notify(`没有 "${filter}" 状态的计划`, "info");
				return;
			}

			const icon: Record<string, string> = {
				"in-progress": "●",
				done: "✓",
				abandoned: "✗",
			};

			// Read each plan's task progress
			const lines = filtered.map((p) => {
				const dir = planDir(ctx.cwd, p.name);
				const snapshot = readTasksJsonl(dir);
				let progress = "";
				if (snapshot) {
					const done = snapshot.tasks.filter((t) => t.status === "done" || t.status === "skipped").length;
					progress = ` (${done}/${snapshot.tasks.length})`;
				}
				const date = p.completed_at ?? p.created_at;
				const dateStr = date ? date.slice(0, 10) : "";
				return `${icon[p.status] ?? "●"} [${p.status}]${progress} ${p.name} — ${p.title} (${dateStr})`;
			});

			const header = filter
				? `计划列表 (过滤: ${filter}) - ${filtered.length} 项`
				: `所有计划 - ${all.length} 项\n用法: /plans [in-progress|done|abandoned]`;

			ctx.ui.notify(`${header}\n\n${lines.join("\n")}`, "info");
		},
	});

	pi.registerCommand("todos", {
		description: "Show current plan task progress",
		handler: async (_args, ctx) => {
			attachInProgressPlan(ctx.cwd);
			if (!state.plan || state.plan.tasks.length === 0) {
				ctx.ui.notify("没有活跃的计划，使用 /plan 开始规划（多个 in-progress 时用 /plan resume）", "info");
				return;
			}
			const icon: Record<string, string> = { pending: "○", done: "✓", skipped: "⊘", blocked: "✗", deferred: "⏸" };
			const list = state.plan.tasks
				.map((t) => `${t.id}. ${icon[t.status] ?? "○"} ${t.description}`)
				.join("\n");
			const done = state.plan.tasks.filter((t) => t.status === "done" || t.status === "skipped").length;
			ctx.ui.notify(`${state.plan.title} — ${done}/${state.plan.tasks.length}\n\n${list}`, "info");
		},
	});

	// ── Shortcut ──────────────────────────────────────────────────────────────
	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => {
			if (state.planEnabled || state.executing) {
				await exitToNormal(state, pi, ctx);
			} else {
				const planModel = await pickPlanModel(ctx);
				if (planModel === undefined) return;
				await enterPlanMode(state, pi, ctx, planModel);
			}
			updateUI(ctx);
			persistState(ctx);
		},
	});

	// ── Exec session launcher ─────────────────────────────────────────────────
	async function launchExecSession(ctx: any, execModel: ModelDef, dir: string): Promise<void> {
		const parentSession = ctx.sessionManager.getSessionFile();
		state.parentSession = parentSession;

		const handoff = readHandoff(dir);
		const kickoff = handoff
			? `请阅读以下计划并开始执行。完成每项任务后调用 update_task 标记进度。\n\n${handoff}`
			: "请执行计划中的任务，完成后调用 update_task 标记进度。";

		writeExecPending(ctx.cwd, {
			planDir: dir,
			parentSession,
			kickoff,
			config: { model: execModel, thinking: EXEC_THINKING },
			createdAt: new Date().toISOString(),
		});

		ctx.ui.notify(`正在创建执行会话... model=${execModel.id}`, "info");

		try {
			const result = await ctx.newSession({
				parentSession,
				withSession: async (newCtx: any) => {
					await newCtx.sendUserMessage(kickoff);
				},
			});
			if (result?.cancelled) {
				// User aborted the picker before the new session ran session_start,
				// so .exec-pending.json is still on disk. Clear it so the next
				// unrelated session_start doesn't get hijacked.
				clearExecPending(ctx.cwd);
				ctx.ui.notify("执行会话创建被取消", "warning");
			}
		} catch (err) {
			clearExecPending(ctx.cwd);
			ctx.ui.notify(`launchExecSession 失败: ${err instanceof Error ? err.message : String(err)}`, "error");
		}
	}

	// ── Event: block writes + dangerous bash in plan mode ────────────────────
	pi.on("tool_call", async (event) => {
		if (!state.planEnabled) return;

		if (event.toolName === "bash") {
			const cmd = (event.input.command as string) ?? "";
			if (isDangerousCommand(cmd)) {
				return {
					block: true,
					reason: `规划模式：已阻止危险命令。请先 /plan exit 退出规划模式。\n命令: ${cmd}`,
				};
			}
		}

		if (event.toolName === "edit" || event.toolName === "write") {
			const p = (event.input.path as string) ?? "";
			if (!p.includes(".plans/")) {
				return {
					block: true,
					reason: `规划模式：写入限制在 .plans/ 目录。路径: ${p}`,
				};
			}
		}
	});

	// ── Event: context filter ─────────────────────────────────────────────────
	pi.on("context", async (event) => {
		// Not in plan/exec mode: filter out injected prompt messages
		if (!state.planEnabled && !state.executing) {
			return {
				messages: event.messages.filter((msg: any) => {
					return msg.customType !== "plan-mode-context" && msg.customType !== "plan-exec-context";
				}),
			};
		}
		// In plan/exec mode: pass through
	});

	// ── Event: inject phase prompts ───────────────────────────────────────────
	pi.on("before_agent_start", async () => {
		if (state.planEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: buildPlanModePrompt(),
					display: false,
				},
			};
		}
		if (state.executing && state.plan) {
			return {
				message: {
					customType: "plan-exec-context",
					content: buildExecPrompt(state.plan),
					display: false,
				},
			};
		}
	});

	// ── Event: turn_end — reload tasks from disk + refresh widget ───────────
	pi.on("turn_end", async (_event, ctx) => {
		if (!(state.executing || state.planEnabled)) return;
		// Reload tasks from disk — subagent’s update_task writes the file
		// from a child process, so our in-memory state.plan.tasks is stale.
		if (state.plan && state.planDir) {
			const snapshot = readTasksJsonl(state.planDir);
			if (snapshot) state.plan.tasks = snapshot.tasks;
		}
		updateUI(ctx);
	});

	// ── Event: agent_end ──────────────────────────────────────────────────────
	pi.on("agent_end", async (_event, ctx) => {
		// ── Plan phase: plan submitted → notify user (newSession unavailable in agent_end ctx) ──
		if (state.planEnabled && state.plan && state.planDir) {
			const hint = `计划「${state.plan.title}」已提交 (${state.plan.tasks.length} 个任务)\n\n下一步:\n  直接说明需要什么调整 — 会全量重提交\n  /plan exec         — 默认 Sonnet 4.6 执行\n  /plan exec ds      — 用 DeepSeek 执行\n  /plan exec opus    — 用 Opus 执行\n  /plan exit         — 退出规划模式`;
			ctx.ui.notify(hint, "info");
			return;
		}

		if (!state.executing || !state.plan) return;

		updateUI(ctx);

		const blocked = state.plan.tasks.filter((t) => t.status === "blocked");
		if (blocked.length > 0) {
			// Loop through every blocked task in one menu pass — otherwise the
			// executor has to spin a full LLM turn between each blocked task
			// just to land back here.
			const retryInstructions: string[] = [];
			let skipCount = 0;
			let aborted = false;
			let returnedToParent = false;

			while (true) {
				const remaining = state.plan.tasks.filter((t) => t.status === "blocked");
				if (remaining.length === 0) break;
				const bs = remaining[0];
				const countSuffix = remaining.length > 1 ? `  (还有 ${remaining.length - 1} 个阻塞任务)` : "";
				const info = `Task ${bs.id}: ${bs.description}${bs.notes ? `\n原因: ${bs.notes}` : ""}${countSuffix}`;
				const choice = await ctx.ui.select(`任务阻塞 — ${info}\n\n下一步?`, [
					"跳过此任务",
					"提供补充说明后重试",
					"切回主会话重新规划",
					"中止执行",
				]);

				if (choice === "跳过此任务") {
					bs.status = "skipped";
					bs.updated_at = new Date().toISOString();
					skipCount++;
				} else if (choice === "提供补充说明后重试") {
					const instructions = await ctx.ui.editor("补充说明:", "");
					if (instructions?.trim()) {
						bs.status = "pending";
						bs.notes = undefined;
						bs.updated_at = new Date().toISOString();
						retryInstructions.push(`Task ${bs.id} (${bs.description}): ${instructions.trim()}`);
					} else {
						// User canceled the editor — leave the task blocked and exit the loop,
						// otherwise we spin forever on the same task.
						break;
					}
				} else if (choice === "切回主会话重新规划") {
					syncTasks();
					await handleReturn(ctx, `有任务阻塞: ${bs.description}。原因: ${bs.notes ?? "未知"}，需要重新规划。`);
					returnedToParent = true;
					break;
				} else {
					// 中止执行 or menu dismissed
					aborted = true;
					break;
				}
			}

			if (returnedToParent) return;

			if (aborted) {
				syncTasks();
				await exitToNormal(state, pi, ctx);
				updateUI(ctx);
				persistState(ctx);
				return;
			}

			syncTasks();
			updateUI(ctx);
			persistState(ctx);

			// Only prod the executor when we actually changed something AND there's
			// pending work left. If nothing happened (e.g. user canceled the editor)
			// or there's no pending work, stay silent — saves an LLM turn.
			const madeProgress = skipCount > 0 || retryInstructions.length > 0;
			const hasPending = state.plan.tasks.some((t) => t.status === "pending");
			if (madeProgress && hasPending) {
				const parts: string[] = [];
				if (retryInstructions.length > 0) {
					parts.push(`重试说明:\n${retryInstructions.join("\n")}`);
				}
				if (skipCount > 0) {
					parts.push(`已跳过 ${skipCount} 个阻塞任务。`);
				}
				parts.push("继续执行剩余任务。");
				pi.sendUserMessage(parts.join("\n\n"), { deliverAs: "followUp" });
			}
			return;
		}

		// Check completion
		const allDone = state.plan.tasks.every((t) => t.status === "done" || t.status === "skipped");
		if (allDone) {
			const done = state.plan.tasks.filter((t) => t.status === "done").length;
			const skipped = state.plan.tasks.filter((t) => t.status === "skipped").length;
			const deferred = state.plan.tasks.filter((t) => t.status === "deferred").length;

			// Mark plan done in registry
			if (state.planDir) {
				upsertPlanRegistry(ctx.cwd, {
					name: state.plan.planName,
					title: state.plan.title,
					status: "done",
					created_at: state.plan.tasks[0]?.created_at ?? new Date().toISOString(),
					completed_at: new Date().toISOString(),
				});
			}

			const summary = [
				`**计划完成 ✓** — ${state.plan.title}`,
				`完成: ${done} | 跳过: ${skipped}${deferred > 0 ? ` | 后续待处理: ${deferred}` : ""}`,
				"",
				...state.plan.tasks.map((t) => {
					const icon: Record<string, string> = { done: "✓", skipped: "⊘", deferred: "⏸", blocked: "✗", pending: "○" };
					return `${icon[t.status] ?? "○"} ${t.id}. ${t.description}${t.notes ? ` — ${t.notes}` : ""}`;
				}),
			].join("\n");

			pi.sendMessage(
				{ customType: "plan-complete", content: summary, display: true },
				{ triggerTurn: false },
			);

			const choice = await ctx.ui.select("计划执行完成，下一步?", [
				"切回主会话",
				"留在当前会话继续验证 (之后用 /plan back 切回)",
			]);

			if (choice === "切回主会话") {
				await handleReturn(ctx, summary);
			} else {
				await exitToNormal(state, pi, ctx);
				updateUI(ctx);
				persistState(ctx);
			}
		}
	});

	// ── Event: session_start (restore state + handle exec-pending) ────────────
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) state.planEnabled = true;

		// Restore persisted state from session entries
		const entries = ctx.sessionManager.getEntries() as any[];
		const saved = entries
			.filter((e) => e.type === "custom" && e.customType === "plan-execute-state")
			.pop();

		if (saved?.data) {
			// Whitelist restore — only fields that are meaningful across session
			// restarts. Skips transient flags (e.g. userExited) that should reset
			// each launch, and indices (executionStartIdx) that don't survive
			// a new session anyway.
			const d = saved.data as Partial<PlanExecuteState>;
			if (typeof d.planEnabled === "boolean") state.planEnabled = d.planEnabled;
			if (typeof d.executing === "boolean") state.executing = d.executing;
			if (d.planDir !== undefined) state.planDir = d.planDir;
			if (d.plan !== undefined) state.plan = d.plan;
			if (d.parentSession !== undefined) state.parentSession = d.parentSession;
			if (d.previousModel !== undefined) state.previousModel = d.previousModel;
			if (d.previousThinking !== undefined) state.previousThinking = d.previousThinking;
		}

		// Check for exec-pending handoff (from planning session)
		const pending = readAndClearExecPending(ctx.cwd);
		if (pending) {
			const snapshot = readTasksJsonl(pending.planDir);
			if (snapshot) {
				state.plan = {
					title: snapshot.meta.title,
					planName: snapshot.meta.plan_name,
					handoff: readHandoff(pending.planDir),
					tasks: snapshot.tasks,
				};
				state.planDir = pending.planDir;
				state.parentSession = pending.parentSession;
				state.executionStartIdx = ctx.sessionManager.getEntries().length;

				await enterExecMode(state, pi, ctx, pending.config.model, state.executionStartIdx);
				updateUI(ctx);
				persistState(ctx);
				return;
			}
		}

		// Auto-load from disk if no plan in session state
		// (handles new sessions after restart, or cross-session plan resumption)
		// Skip if user explicitly exited in this session
		if (!state.plan && !state.userExited) {
			const inProgress = findInProgressPlans(ctx.cwd);
			if (inProgress.length === 1) {
				// Single in-progress plan: auto-attach (data only, no mode switch)
				const entry = inProgress[0];
				const dir = planDir(ctx.cwd, entry.name);
				const snapshot = readTasksJsonl(dir);
				if (snapshot) {
					state.plan = {
						title: snapshot.meta.title,
						planName: snapshot.meta.plan_name,
						handoff: readHandoff(dir),
						tasks: snapshot.tasks,
					};
					state.planDir = dir;
				}
			}
			// Multiple in-progress plans: don't auto-pick, user must /plan resume
		}

		// Apply tool / model from restored state
		if (state.planEnabled) {
			pi.setActiveTools(PLAN_TOOLS);
			pi.setThinkingLevel(PLAN_THINKING);
		} else if (state.executing) {
			pi.setActiveTools(EXEC_TOOLS);
			pi.setThinkingLevel(EXEC_THINKING as any);
		}

		updateUI(ctx);
	});

	// ── Helpers ───────────────────────────────────────────────────────────────

	// 如果 state.plan 为空，尝试从磁盘加载 in-progress 计划（忽略 userExited）。
	// 返回是否成功加载。多个 in-progress 时返回 false。
	function attachInProgressPlan(cwd: string): boolean {
		if (state.plan) return true;
		const inProgress = findInProgressPlans(cwd);
		if (inProgress.length !== 1) return false;
		const dir = planDir(cwd, inProgress[0].name);
		const snapshot = readTasksJsonl(dir);
		if (!snapshot) return false;
		state.plan = {
			title: snapshot.meta.title,
			planName: snapshot.meta.plan_name,
			handoff: readHandoff(dir),
			tasks: snapshot.tasks,
		};
		state.planDir = dir;
		return true;
	}

	function syncTasks(): void {
		if (!state.plan || !state.planDir) return;
		const meta = {
			_type: "meta" as const,
			title: state.plan.title,
			plan_name: state.plan.planName,
			created_at: state.plan.tasks[0]?.created_at ?? new Date().toISOString(),
		};
		writeTasksJsonl(state.planDir, meta, state.plan.tasks);
	}

	async function handleReturn(ctx: any, summary: string): Promise<void> {
		const parentSession = state.parentSession;

		// agent_end ctx 不带 switchSession（只有 command handler 才有）。
		// 只能提示用户手动切回主会话。
		state.planEnabled = false;
		state.executing = false;
		state.executionStartIdx = undefined;

		pi.sendMessage(
			{ customType: "plan-result", content: summary, display: true },
			{ triggerTurn: false },
		);

		if (parentSession) {
			ctx.ui.notify(`计划已完成。使用 /plan back 切回主会话`, "info");
		}

		updateUI(ctx);
		persistState(ctx);
	}
}

// ── Bash safety ───────────────────────────────────────────────────────────────

const DANGEROUS_PATTERNS = [
	/\brm\b/, /\bmv\b/, /\bcp\b/, /\bmkdir\b/, /\btouch\b/,
	/\bgit\s+(add|commit|push|reset|clean|checkout|merge|rebase)\b/,
	/\bnpm\s+(install|uninstall|update)\b/, /\bpnpm\s+(install|add|remove)\b/,
	/\byarn\s+(add|remove|install)\b/, /\bpip\s+install\b/,
	/\bsudo\b/, /\bkill\b/, /\bchmod\b/, /\bchown\b/,
	/\bvim?\b/, /\bnano\b/, /\bcode\b/,
];

function isDangerousCommand(cmd: string): boolean {
	return DANGEROUS_PATTERNS.some((p) => p.test(cmd));
}
