import assert from "node:assert/strict";
import { test } from "node:test";
import { CalloutActivity, countNoteActivity, placeActivityBadges, activityDescription } from "../src/activity.ts";

const counts = (queued = 0, running = 0, publishing = 0) => ({ queued, running, publishing });
const file = path => ({ path, kind: "file", collapsed: false });
const folder = (path, collapsed = true) => ({ path, kind: "folder", collapsed });

test("callouts follow live file identity, stay active through publication, and finish independently", () => {
	const activity = new CalloutActivity(), note = { path: "Old.md" };
	const older = activity.begin(note), newer = activity.begin(note);
	note.path = "Moved/New.md";
	activity.publishing(older);
	assert.deepEqual(countNoteActivity(activity.snapshot()).get(note.path), counts(0, 1, 1));
	activity.finish(older);
	activity.finish(older);
	assert.deepEqual(countNoteActivity(activity.snapshot()).get(note.path), counts(0, 1, 0));
	activity.publishing(older); // A late update from an old execution cannot revive it.
	activity.publishing(newer);
	assert.deepEqual(countNoteActivity(activity.snapshot()).get(note.path), counts(0, 0, 1));
	activity.clear();
	assert.deepEqual(activity.snapshot(), []);
});

test("mixed sources and simultaneous requests produce one count snapshot per note", () => {
	const result = countNoteActivity([
		{ notePath: "A.md", phase: "running" }, { notePath: "A.md", phase: "queued" },
		{ notePath: "A.md", phase: "publishing" }, { notePath: "B.md", phase: "running" },
	]);
	assert.equal(result.size, 2);
	assert.deepEqual(result.get("A.md"), counts(1, 1, 1));
	const badges = placeActivityBadges(result, [file("A.md"), file("B.md")]);
	assert.deepEqual(badges.get("A.md"), { notes: 1, ...counts(1, 1, 1) });
});

test("the outermost collapsed folder receives hidden activity, counting notes rather than jobs", () => {
	const notes = new Map([["Projects/A.md", counts(1, 2)], ["Projects/Sub/B.md", counts(0, 0, 1)], ["ProjectsOther/C.md", counts(1)]]);
	const rows = [folder("Projects"), folder("Projects/Sub"), file("Projects/A.md"), file("Projects/Sub/B.md"), file("ProjectsOther/C.md")];
	const badges = placeActivityBadges(notes, rows);
	assert.deepEqual(badges.get("Projects"), { notes: 2, ...counts(1, 2, 1) });
	assert.equal(badges.has("Projects/Sub"), false);
	assert.equal(badges.has("Projects/A.md"), false);
	assert.deepEqual(badges.get("ProjectsOther/C.md"), { notes: 1, ...counts(1) });
	rows[0].collapsed = false;
	const expanded = placeActivityBadges(notes, rows);
	assert.equal(expanded.has("Projects"), false);
	assert.equal(expanded.get("Projects/Sub").notes, 1);
	assert.equal(expanded.get("Projects/A.md").notes, 1);
	rows[1].collapsed = false;
	assert.equal(placeActivityBadges(notes, rows).has("Projects/Sub/B.md"), true);
});

test("lazy descendants roll up without file rows; missing rows and empty activity stay undecorated", () => {
	const notes = new Map([["Moved/Nested/A.md", counts(1)]]);
	assert.equal(placeActivityBadges(notes, [folder("Moved")]).get("Moved").notes, 1);
	assert.equal(placeActivityBadges(notes, [folder("Moved", false)]).size, 0);
	assert.equal(placeActivityBadges(new Map(), [folder("Moved")]).size, 0);
	assert.equal(placeActivityBadges(new Map([["A.md", counts()]]), [file("A.md")]).size, 0);
});

test("renaming notes and folders moves badges and deleting notes removes them", () => {
	const activity = new CalloutActivity(), note = { path: "Before/A.md" };
	activity.begin(note);
	note.path = "After/Renamed.md";
	const rows = [folder("Before"), folder("After")];
	const badges = placeActivityBadges(countNoteActivity(activity.snapshot()), rows);
	assert.deepEqual([...badges.keys()], ["After"]);
	const existing = new Set();
	const filtered = activity.snapshot(note => existing.has(note));
	assert.equal(placeActivityBadges(countNoteActivity(filtered), rows).size, 0);
});

test("tooltips expose all three phases and distinct folder note counts", () => {
	assert.equal(activityDescription({ notes: 2, ...counts(1, 2, 3) }, true), "AI activity: 2 notes; 1 queued, 2 running, 3 publishing");
	assert.equal(activityDescription({ notes: 1, ...counts(1) }, true), "AI activity: 1 note; 1 queued, 0 running, 0 publishing");
	assert.equal(activityDescription({ notes: 1, ...counts(1) }, false), "AI activity: 1 queued, 0 running, 0 publishing");
});
