import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

// Exercise the actual summariser lifecycle with a controllable CLI and vault.
const result = await build({
	entryPoints: ["src/summariser.ts"], bundle: true, platform: "node", format: "esm", write: false,
	plugins: [{ name: "summariser-host", setup(builder) {
		builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "host", namespace: "test" }));
		builder.onResolve({ filter: /^\.\/agent\.ts$/ }, () => ({ path: "agent", namespace: "test" }));
		builder.onLoad({ filter: /.*/, namespace: "test" }, ({ path }) => ({ contents: path === "agent"
			? "export const runAgent = options => globalThis.__aioActivityLaunch(options);"
			: "export class MarkdownView {} export class TFile {} export class Notice {}" }));
	} }],
});
const { Summariser } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(predicate) {
	for (let index = 0; index < 100; index++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
	assert.fail("activity did not settle");
}

function fixture(t) {
	const runs = [], writes = [], note = { path: "Before.md" };
	globalThis.document = { body: { classList: { toggle() {}, remove() {} } } };
	globalThis.__aioActivityLaunch = options => {
		const pending = deferred();
		const run = { options, ...pending, result: pending.promise, cancel() { this.cancelled = true; } };
		runs.push(run); return run;
	};
	t.after(() => { delete globalThis.document; delete globalThis.__aioActivityLaunch; });
	const plugin = {
		settings: { provider: "codex", timeoutSeconds: 5 }, model: () => "", command: () => "fixture",
		vaultRoot: () => "/fixture", effort: () => "", extraArgs: () => [], env: () => ({}),
		app: { workspace: { getActiveViewOfType: () => null }, vault: {
			getAbstractFileByPath: path => path === note.path ? note : null,
			read: async () => "> [!ai]\n> Review this note.\n",
			process: async (file, transform) => { const pending = deferred(); writes.push({ file, transform, ...pending }); await pending.promise; },
		} },
	};
	const summariser = new Summariser(plugin);
	return { summariser, runs, writes, note };
}

test("summariser keeps renamed notes active until vault publication completes", async t => {
	const f = fixture(t);
	await f.summariser.scan(f.note);
	assert.deepEqual(f.summariser.activity(), [{ notePath: "Before.md", phase: "running" }]);
	f.note.path = "Moved/After.md";
	f.runs[0].resolve({ title: "Review", body: "Done." });
	await until(() => f.writes.length === 1);
	assert.deepEqual(f.summariser.activity(), [{ notePath: "Moved/After.md", phase: "publishing" }]);
	f.writes[0].resolve();
	await until(() => f.summariser.activity().length === 0);
});

test("a replaced execution finishing late cannot hide the new execution", async t => {
	const f = fixture(t);
	await f.summariser.scan(f.note);
	const replacement = f.summariser.regenerateAtCursor(f.note, 0);
	await until(() => f.runs.length === 2);
	assert.equal(f.runs[0].cancelled, true);
	f.runs[0].reject(new Error("Cancelled."));
	await until(() => f.summariser.activity().length === 1);
	assert.equal(f.summariser.stateIn(f.note.path), "running");
	f.runs[1].resolve({ title: "New review", body: "Done." });
	await until(() => f.writes.length === 1);
	f.writes[0].resolve(); await replacement;
	assert.deepEqual(f.summariser.activity(), []);
	assert.equal(f.summariser.stateIn(f.note.path), "idle");
});

test("deleted callouts cannot attribute old activity to a replacement file at the same path", async t => {
	const f = fixture(t);
	await f.summariser.scan(f.note);
	assert.equal(f.summariser.activity().length, 1);
	f.summariser.plugin.app.vault.getAbstractFileByPath = () => ({ path: f.note.path });
	assert.deepEqual(f.summariser.activity(), []);
	f.runs[0].reject(new Error("Cancelled."));
	await until(() => f.summariser.stateIn(f.note.path) !== "running");
});

test("failed publication and unload clear callout activity", async t => {
	const f = fixture(t);
	await f.summariser.scan(f.note);
	f.runs[0].resolve({ title: "Review", body: "Done." });
	await until(() => f.writes.length === 1);
	f.writes[0].reject(new Error("Write failed"));
	await until(() => f.summariser.activity().length === 0);
	const pending = f.summariser.regenerateAtCursor(f.note, 0);
	await until(() => f.runs.length === 2);
	f.summariser.dispose();
	assert.equal(f.runs[1].cancelled, true);
	assert.deepEqual(f.summariser.activity(), []);
	f.runs[1].reject(new Error("Cancelled.")); await pending;
});
