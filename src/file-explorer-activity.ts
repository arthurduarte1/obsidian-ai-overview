import { App, Component, setTooltip } from "obsidian";
import { activityDescription, placeActivityBadges, type ActivityCounts, type ExplorerRow } from "./activity.ts";

const BADGE = "aio-file-activity";
const ROWS = ".nav-file-title[data-path], .nav-folder-title[data-path]";

interface Explorer {
	observer: MutationObserver;
	badges: Map<HTMLElement, HTMLElement>;
}

/** The only module that depends on the built-in Files explorer's DOM. */
export class FileExplorerActivity extends Component {
	private explorers = new Map<HTMLElement, Explorer>();
	private active = false;
	private pending = false;

	constructor(
		private app: App,
		private enabled: () => boolean,
		private snapshot: () => ReadonlyMap<string, ActivityCounts>,
	) { super(); }

	onload(): void {
		this.active = true;
		this.app.workspace.onLayoutReady(() => this.refresh());
		this.registerEvent(this.app.workspace.on("layout-change", () => this.refresh()));
		this.registerEvent(this.app.workspace.on("window-open", () => this.refresh()));
		this.registerEvent(this.app.workspace.on("window-close", () => this.refresh()));
		this.registerEvent(this.app.vault.on("rename", () => this.refresh()));
		this.registerEvent(this.app.vault.on("delete", () => this.refresh()));
		this.refresh();
	}

	onunload(): void {
		this.active = false;
		for (const [container, explorer] of this.explorers) this.detach(container, explorer);
		this.explorers.clear();
	}

	/** Coalesce progress events and tree mutations; never drive animation with JS. */
	refresh(): void {
		if (!this.active || this.pending) return;
		this.pending = true;
		queueMicrotask(() => {
			this.pending = false;
			if (this.active) this.reconcile();
		});
	}

	private reconcile(): void {
		const containers = new Set<HTMLElement>();
		if (this.enabled()) {
			for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
				const container = leaf.view.containerEl;
				if (container.isConnected) containers.add(container);
			}
		}
		for (const [container, explorer] of this.explorers) {
			if (containers.has(container)) continue;
			this.detach(container, explorer);
			this.explorers.delete(container);
		}
		if (containers.size === 0) return;
		const notes = this.snapshot();
		for (const container of containers) {
			let explorer = this.explorers.get(container);
			if (!explorer) {
				const win = container.ownerDocument.defaultView;
				if (!win) continue;
				explorer = { badges: new Map(), observer: new win.MutationObserver((mutations) => {
					if (mutations.some((mutation) => mutation.type === "childList" ||
						(mutation.target as Element).matches(".nav-folder, [data-path]"))) this.refresh();
				}) };
				this.explorers.set(container, explorer);
			}
			// Synchronous rendering cannot interleave with other observers. Disconnect
			// only ours so its own insertions/removals never schedule another render.
			explorer.observer.disconnect();
			try { this.paint(container, explorer, notes); }
			finally {
				explorer.observer.observe(container, { subtree: true, childList: true,
					attributes: true, attributeFilter: ["class", "data-path"] });
			}
		}
	}

	private paint(container: HTMLElement, explorer: Explorer, notes: ReadonlyMap<string, ActivityCounts>): void {
		const rows = new Map<string, { el: HTMLElement; row: ExplorerRow }>();
		for (const el of Array.from(container.querySelectorAll<HTMLElement>(ROWS))) {
			const path = el.getAttribute("data-path");
			if (!path) continue;
			const kind = el.classList.contains("nav-folder-title") ? "folder" : "file";
			rows.set(path, { el, row: { path, kind,
				collapsed: kind === "folder" && el.parentElement?.classList.contains("is-collapsed") === true } });
		}
		const placements = placeActivityBadges(notes, [...rows.values()].map(({ row }) => row));
		const wanted = new Set([...placements.keys()].map((path) => rows.get(path)!.el));
		for (const [row, badge] of explorer.badges) {
			if (wanted.has(row) && badge.parentElement === row) continue;
			badge.remove();
			explorer.badges.delete(row);
		}
		// A tree redraw may clone a decorated row. Remove only our orphaned copies.
		const owned = new Set(explorer.badges.values());
		for (const badge of Array.from(container.querySelectorAll<HTMLElement>(`.${BADGE}`))) {
			if (!owned.has(badge)) badge.remove();
		}
		for (const [path, counts] of placements) {
			const { el: row, row: { kind } } = rows.get(path)!;
			let badge = explorer.badges.get(row);
			if (!badge) {
				badge = row.createSpan({ cls: BADGE, attr: { role: "img" } });
				const dots = badge.createSpan({ cls: "aio-file-activity-dots", attr: { "aria-hidden": "true" } });
				for (let index = 0; index < 3; index++) dots.createSpan();
				badge.createSpan({ cls: "aio-file-activity-label", attr: { "aria-hidden": "true" } });
				explorer.badges.set(row, badge);
			}
			const state = counts.running + counts.publishing > 0 ? "active" : "queued";
			if (badge.dataset.aioState !== state) badge.dataset.aioState = state;
			const label = kind === "folder" && counts.notes > 1 ? `AI ${counts.notes}` : "AI";
			const text = badge.querySelector<HTMLElement>(".aio-file-activity-label")!;
			if (text.textContent !== label) text.textContent = label;
			const description = activityDescription(counts, kind === "folder");
			if (badge.getAttribute("aria-label") !== description) setTooltip(badge, description);
		}
	}

	private detach(container: HTMLElement, explorer: Explorer): void {
		explorer.observer.disconnect();
		for (const badge of explorer.badges.values()) badge.remove();
		explorer.badges.clear();
		container.querySelectorAll(`.${BADGE}`).forEach((badge) => badge.remove());
	}
}
