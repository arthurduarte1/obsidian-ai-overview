/** Internal UI snapshots; these are never persisted or sent across the bridge. */
export type ActivityPhase = "queued" | "running" | "publishing";

export interface ActivityRun {
	readonly notePath: string;
	readonly phase: ActivityPhase;
}

export interface ActivityCounts {
	readonly queued: number;
	readonly running: number;
	readonly publishing: number;
}

export interface ActivityBadge extends ActivityCounts {
	readonly notes: number;
}

export interface ExplorerRow {
	readonly path: string;
	readonly kind: "file" | "folder";
	readonly collapsed: boolean;
}

/** Execution identity is independent of prompt keys and mutable note paths. */
export class CalloutActivity {
	private runs = new Map<symbol, { note: { readonly path: string }; phase: ActivityPhase }>();

	begin(note: { readonly path: string }): symbol {
		const id = Symbol();
		this.runs.set(id, { note, phase: "running" });
		return id;
	}

	publishing(id: symbol): void {
		const run = this.runs.get(id);
		if (run) run.phase = "publishing";
	}

	finish(id: symbol): void { this.runs.delete(id); }
	clear(): void { this.runs.clear(); }

	snapshot(isPresent: (note: { readonly path: string }) => boolean = () => true): readonly ActivityRun[] {
		return [...this.runs.values()].filter(({ note }) => isPresent(note))
			.map(({ note, phase }) => ({ notePath: note.path, phase }));
	}
}

export function countNoteActivity(runs: readonly ActivityRun[]): ReadonlyMap<string, ActivityCounts> {
	const notes = new Map<string, { queued: number; running: number; publishing: number }>();
	for (const run of runs) {
		const counts = notes.get(run.notePath) ?? { queued: 0, running: 0, publishing: 0 };
		counts[run.phase]++;
		notes.set(run.notePath, counts);
	}
	return notes;
}

/** A collapsed ancestor wins over its hidden descendants, independently per pane. */
export function placeActivityBadges(
	notes: ReadonlyMap<string, ActivityCounts>, rows: readonly ExplorerRow[],
): ReadonlyMap<string, ActivityBadge> {
	const files = new Set(rows.filter((row) => row.kind === "file").map((row) => row.path));
	const collapsed = new Set(rows.filter((row) => row.kind === "folder" && row.collapsed).map((row) => row.path));
	const badges = new Map<string, { notes: number; queued: number; running: number; publishing: number }>();
	for (const [notePath, counts] of notes) {
		let target = files.has(notePath) ? notePath : undefined;
		const parts = notePath.split("/");
		// Walk from the root: a deeper collapsed folder may itself be hidden.
		for (let depth = 1; depth < parts.length; depth++) {
			const ancestor = parts.slice(0, depth).join("/");
			if (collapsed.has(ancestor)) { target = ancestor; break; }
		}
		if (!target || counts.queued + counts.running + counts.publishing === 0) continue;
		const badge = badges.get(target) ?? { notes: 0, queued: 0, running: 0, publishing: 0 };
		badge.notes++;
		badge.queued += counts.queued;
		badge.running += counts.running;
		badge.publishing += counts.publishing;
		badges.set(target, badge);
	}
	return badges;
}

export function activityDescription(counts: ActivityBadge, folder: boolean): string {
	const notes = folder ? `${counts.notes} ${counts.notes === 1 ? "note" : "notes"}; ` : "";
	return `AI activity: ${notes}${counts.queued} queued, ${counts.running} running, ${counts.publishing} publishing`;
}
