/**
 * .plans/ file I/O utilities
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PLANS_DIR, EXEC_PENDING_FILE } from "./constants.ts";
import type { Task, PlanMeta, PlanData, PlanRegistryEntry, ExecPending } from "./types.ts";

// ── Path helpers ──────────────────────────────────────────────────────────────

export function planDir(cwd: string, planName: string): string {
	return path.join(cwd, PLANS_DIR, planName);
}

export function plansJsonlPath(cwd: string): string {
	return path.join(cwd, PLANS_DIR, "plans.jsonl");
}

export function tasksJsonlPath(dir: string): string {
	return path.join(dir, "tasks.jsonl");
}

export function handoffMdPath(dir: string): string {
	return path.join(dir, "HANDOFF.md");
}

// ── tasks.jsonl ───────────────────────────────────────────────────────────────

export function readTasksJsonl(dir: string): { meta: PlanMeta; tasks: Task[] } | null {
	const p = tasksJsonlPath(dir);
	if (!fs.existsSync(p)) return null;

	const lines = fs.readFileSync(p, "utf-8").trim().split("\n").filter(Boolean);
	let meta: PlanMeta | null = null;
	const tasks: Task[] = [];

	for (const line of lines) {
		try {
			const obj = JSON.parse(line);
			if (obj._type === "meta") meta = obj as PlanMeta;
			else tasks.push(obj as Task);
		} catch { /* skip malformed lines */ }
	}

	if (!meta) return null;
	return { meta, tasks };
}

export function writeTasksJsonl(dir: string, meta: PlanMeta, tasks: Task[]): void {
	fs.mkdirSync(dir, { recursive: true });
	const lines = [JSON.stringify(meta), ...tasks.map((t) => JSON.stringify(t))];
	fs.writeFileSync(tasksJsonlPath(dir), lines.join("\n") + "\n", "utf-8");
}

// ── HANDOFF.md ────────────────────────────────────────────────────────────────

export function readHandoff(dir: string): string {
	const p = handoffMdPath(dir);
	return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "";
}

export function writeHandoff(dir: string, content: string): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(handoffMdPath(dir), content, "utf-8");
}

// ── plans.jsonl registry ──────────────────────────────────────────────────────

export function readPlansRegistry(cwd: string): PlanRegistryEntry[] {
	const p = plansJsonlPath(cwd);
	if (!fs.existsSync(p)) return [];
	return fs.readFileSync(p, "utf-8")
		.trim().split("\n").filter(Boolean)
		.flatMap((line) => { try { return [JSON.parse(line) as PlanRegistryEntry]; } catch { return []; } });
}

export function upsertPlanRegistry(cwd: string, entry: PlanRegistryEntry): void {
	const existing = readPlansRegistry(cwd).filter((e) => e.name !== entry.name);
	const all = [...existing, entry];
	fs.mkdirSync(path.join(cwd, PLANS_DIR), { recursive: true });
	fs.writeFileSync(plansJsonlPath(cwd), all.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

// ── submit plan (atomic) ──────────────────────────────────────────────────────

export function submitPlan(cwd: string, planName: string, title: string, tasks: Task[], handoff: string): string {
	const dir = planDir(cwd, planName);
	const now = new Date().toISOString();
	const meta: PlanMeta = { _type: "meta", title, plan_name: planName, created_at: now };
	writeTasksJsonl(dir, meta, tasks);
	writeHandoff(dir, handoff);
	upsertPlanRegistry(cwd, { name: planName, title, status: "in-progress", created_at: now });
	return dir;
}

// ── exec-pending ──────────────────────────────────────────────────────────────

export function writeExecPending(cwd: string, pending: ExecPending): void {
	const p = path.join(cwd, EXEC_PENDING_FILE);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, JSON.stringify(pending, null, 2), "utf-8");
}

export function readAndClearExecPending(cwd: string): ExecPending | null {
	const p = path.join(cwd, EXEC_PENDING_FILE);
	if (!fs.existsSync(p)) return null;
	try {
		const data = JSON.parse(fs.readFileSync(p, "utf-8")) as ExecPending;
		fs.unlinkSync(p);
		return data;
	} catch {
		try { fs.unlinkSync(p); } catch { /* ignore */ }
		return null;
	}
}

// ── find in-progress plans ────────────────────────────────────────────────────

export function findInProgressPlans(cwd: string): PlanRegistryEntry[] {
	return readPlansRegistry(cwd).filter((e) => e.status === "in-progress");
}
