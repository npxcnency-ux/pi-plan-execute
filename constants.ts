/**
 * Plan-Execute extension constants
 */

export const PLAN_TOOLS = [
	"read",
	"bash",
	"grep",
	"find",
	"ls",
	"subagent",
	"submit_plan",
];

export const EXEC_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"subagent",
	"update_task",
	"add_task",
	"plan_status",
];

// ── Model alias map ───────────────────────────────────────────────────────────

export type ModelDef = { provider: string; id: string };

export const MODEL_ALIASES: Record<string, ModelDef> = {
	opus:    { provider: "anthropic", id: "aws-claude-opus-4-7[1m]" },
	op:      { provider: "anthropic", id: "aws-claude-opus-4-7[1m]" },
	opus47:  { provider: "anthropic", id: "aws-claude-opus-4-7[1m]" },
	opus46:  { provider: "anthropic", id: "aws-claude-opus-4-6[1m]" },
	sonnet:  { provider: "anthropic", id: "aws-claude-sonnet-4-6[1m]" },
	s:       { provider: "anthropic", id: "aws-claude-sonnet-4-6[1m]" },
	haiku:   { provider: "anthropic", id: "aws-claude-haiku-4-5" },
	ds:      { provider: "kpi", id: "kivy-deepseek-v4-pro[1m]" },
	kimi:    { provider: "kpi", id: "kivy-kimi-k2_5" },
	qwen:    { provider: "kpi", id: "kivy-qwen3.7-max" },
	minimax: { provider: "kpi", id: "kivy-minimax-m2_5" },
};

export function resolveModelAlias(alias: string): ModelDef | null {
	return MODEL_ALIASES[alias.toLowerCase()] ?? null;
}

// ── Plan model picker options ─────────────────────────────────────────────────

export const PLAN_MODEL_OPTIONS: Array<{ label: string; model: ModelDef | null }> = [
	{ label: "Opus 4.7 (kPI)",       model: { provider: "anthropic", id: "aws-claude-opus-4-7[1m]" } },
	{ label: "Opus 4.6 (kPI)",       model: { provider: "anthropic", id: "aws-claude-opus-4-6[1m]" } },
	{ label: "Sonnet 4.6 (kPI)",     model: { provider: "anthropic", id: "aws-claude-sonnet-4-6[1m]" } },
	{ label: "DeepSeek V4 Pro",      model: { provider: "kpi", id: "kivy-deepseek-v4-pro" } },
	{ label: "Kimi K2.5",            model: { provider: "kpi", id: "kivy-kimi-k2_5" } },
	{ label: "当前模型（不切换）",     model: null },
];

export const EXEC_MODEL_OPTIONS: Array<{ label: string; alias: string; model: ModelDef }> = [
	{ label: "Sonnet 4.6 (kPI)", alias: "sonnet", model: { provider: "anthropic", id: "aws-claude-sonnet-4-6[1m]" } },
	{ label: "DeepSeek V4 Pro [1M]", alias: "ds", model: { provider: "kpi", id: "kivy-deepseek-v4-pro[1m]" } },
	{ label: "Kimi K2.5",        alias: "kimi",   model: { provider: "kpi", id: "kivy-kimi-k2_5" } },
	{ label: "Qwen 3.7 Max",     alias: "qwen",   model: { provider: "kpi", id: "kivy-qwen3.7-max" } },
	{ label: "Opus 4.7 (kPI)",   alias: "opus",   model: { provider: "anthropic", id: "aws-claude-opus-4-7[1m]" } },
];

export const PLAN_THINKING = "high" as const;
export const EXEC_THINKING = "low" as const;

export const EXEC_PENDING_FILE = ".plans/.exec-pending.json";
export const PLANS_DIR = ".plans";
