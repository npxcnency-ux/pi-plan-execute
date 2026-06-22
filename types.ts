/**
 * Plan-Execute extension types
 */

import type { ModelDef } from "./constants.ts";

export type TaskStatus = "pending" | "done" | "skipped" | "blocked" | "deferred";
export type ThinkingLevel = "off" | "low" | "medium" | "high" | "max";

export interface Task {
	id: string;
	description: string;
	status: TaskStatus;
	depends_on: string[];
	notes?: string;
	created_at: string;
	updated_at?: string;
}

export interface PlanMeta {
	_type: "meta";
	title: string;
	plan_name: string;
	created_at: string;
}

export interface PlanData {
	title: string;
	planName: string;
	handoff: string;
	tasks: Task[];
}

export interface PlanRegistryEntry {
	name: string;
	title: string;
	status: "in-progress" | "done" | "abandoned";
	created_at: string;
	completed_at?: string;
}

export interface ExecPending {
	planDir: string;
	parentSession: string | null;
	kickoff: string;
	config: {
		model: ModelDef;
		thinking: string;
	};
	createdAt: string;
}

export interface PlanExecuteState {
	planEnabled: boolean;
	executing: boolean;
	userExited?: boolean;
	planDir?: string;
	plan?: PlanData;
	parentSession?: string | null;
	executionStartIdx?: number;
	previousModel?: ModelDef;
	previousThinking?: ThinkingLevel;
}
