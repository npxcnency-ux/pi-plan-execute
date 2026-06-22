/**
 * Phase transitions — enter/exit plan mode, switch models
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelDef } from "./constants.ts";
import type { ThinkingLevel } from "./types.ts";
import { PLAN_TOOLS, EXEC_TOOLS, PLAN_THINKING, EXEC_THINKING } from "./constants.ts";
import type { PlanExecuteState } from "./types.ts";

type AnyCtx = { modelRegistry: any; ui: any; model?: any };

export async function switchModel(
	pi: ExtensionAPI,
	ctx: AnyCtx,
	target: ModelDef,
): Promise<boolean> {
	const model = ctx.modelRegistry.find(target.provider, target.id);
	if (!model) {
		ctx.ui.notify(`模型未找到: ${target.provider}/${target.id}`, "error");
		return false;
	}
	const ok = await pi.setModel(model);
	if (!ok) {
		ctx.ui.notify(`无 API Key: ${target.provider}/${target.id}`, "error");
		return false;
	}
	return true;
}

/**
 * Anthropic 支持 extended thinking；kpi/openai 端点不支持，
 * 强行传 reasoning effort 会 404。按 provider 选合适的 thinking level。
 */
function planThinkingFor(model: ModelDef | null, currentProvider?: string): ThinkingLevel {
	const provider = model?.provider ?? currentProvider ?? "";
	return provider === "anthropic" ? PLAN_THINKING : "off";
}

export async function enterPlanMode(
	state: PlanExecuteState,
	pi: ExtensionAPI,
	ctx: AnyCtx,
	planModel: ModelDef | null,
): Promise<void> {
	// Save current state
	state.previousThinking = pi.getThinkingLevel() as ThinkingLevel;
	state.previousModel = ctx.model
		? { provider: ctx.model.provider, id: ctx.model.id }
		: undefined;

	state.planEnabled = true;
	state.executing = false;
	state.plan = undefined;
	state.planDir = undefined;
	state.userExited = false;

	const thinking = planThinkingFor(planModel, ctx.model?.provider);
	pi.setActiveTools(PLAN_TOOLS);
	pi.setThinkingLevel(thinking);

	if (planModel) {
		await switchModel(pi, ctx, planModel);
		ctx.ui.notify(`📝 规划模式 — ${planModel.id}:${thinking}`, "info");
	} else {
		ctx.ui.notify(`📝 规划模式 — 当前模型:${thinking}`, "info");
	}
}

export async function enterExecMode(
	state: PlanExecuteState,
	pi: ExtensionAPI,
	ctx: AnyCtx,
	execModel: ModelDef,
	executionStartIdx: number,
): Promise<void> {
	state.planEnabled = false;
	state.executing = true;
	state.executionStartIdx = executionStartIdx;

	pi.setActiveTools(EXEC_TOOLS);
	pi.setThinkingLevel(EXEC_THINKING);
	await switchModel(pi, ctx, execModel);
	ctx.ui.notify(`📋 执行模式 — ${execModel.id}:${EXEC_THINKING}`, "info");
}

export async function exitToNormal(
	state: PlanExecuteState,
	pi: ExtensionAPI,
	ctx: AnyCtx,
): Promise<void> {
	const { previousModel, previousThinking } = state;

	state.planEnabled = false;
	state.executing = false;
	state.executionStartIdx = undefined;

	pi.setActiveTools(EXEC_TOOLS);

	if (previousModel) await switchModel(pi, ctx, previousModel);
	if (previousThinking) pi.setThinkingLevel(previousThinking);

	ctx.ui.notify("已退出规划模式，恢复原模型", "info");
}
