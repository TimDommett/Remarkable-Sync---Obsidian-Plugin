/**
 * Unit tests for SyncManager logging.
 *
 * Focus: every sync run must produce a human-readable log file that records
 * per-document failures, so users can troubleshoot sync errors (issue #16).
 *
 * Run: npx tsx --test src/sync-manager.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SyncManager, SyncState, isInExcludedFolder, parseFolderList } from "./sync-manager";
import type { DocumentMetadata, FileOps, RemarkableCloudClient } from "./cloud-client";

/** In-memory FileOps that records all writes (binary writes also logged by path). */
function memoryFileOps(): {
	ops: FileOps;
	files: Map<string, string>;
	binaryWrites: string[];
} {
	const files = new Map<string, string>();
	const binaryWrites: string[] = [];
	const ops: FileOps = {
		readFile: async (p: string) => files.get(p) ?? null,
		writeFile: async (p: string, data: string) => {
			files.set(p, data);
		},
		writeBinaryFile: async (p: string, data: Uint8Array) => {
			binaryWrites.push(p);
			files.set(p, `<binary:${data.length}>`);
		},
		mkdir: async () => {},
		exists: async (p: string) => files.has(p),
		deleteFile: async (p: string) => {
			files.delete(p);
		},
	};
	return { ops, files, binaryWrites };
}

function doc(
	id: string,
	name: string,
	version = 1,
	entryHash = ""
): DocumentMetadata {
	return {
		id,
		version,
		name,
		parent: "",
		docType: "DocumentType",
		modifiedTime: "",
		pinned: false,
		isTrashed: false,
		entryHash,
	};
}

/** Stored-state fixture; only the fields under test vary. */
function syncedInfo(entryHash?: string, path = "reMarkable/Notes.pdf") {
	return {
		version: 5,
		path,
		hash: "deadbeef",
		syncedAt: "2026-01-01T00:00:00Z",
		...(entryHash === undefined ? {} : { entryHash }),
	};
}

/** Fake client whose downloads always fail, forcing a sync error. */
function failingClient(docs: DocumentMetadata[]): RemarkableCloudClient {
	return {
		isAuthenticated: true,
		listDocuments: async () => docs,
		downloadDocument: async (id: string) => {
			throw new Error(`boom for ${id}`);
		},
	} as unknown as RemarkableCloudClient;
}

/** Fake client serving a minimal convertible document (one empty page). */
function successClient(docs: DocumentMetadata[]): RemarkableCloudClient {
	return {
		isAuthenticated: true,
		listDocuments: async () => docs,
		downloadDocument: async (id: string) =>
			new Map([
				[`${id}.content`, new TextEncoder().encode('{"pages":["p1"]}')],
			]),
	} as unknown as RemarkableCloudClient;
}

const LOG_FILE = "/vault/reMarkable/_test-sync-log.md";

test("sync writes a log file capturing per-document errors", async () => {
	const { ops, files } = memoryFileOps();
	const manager = new SyncManager(
		"/vault",
		"reMarkable",
		ops,
		new SyncState()
	);

	const results = await manager.sync(failingClient([doc("doc-1", "Notes")]), {
		logFileName: "_test-sync-log.md",
	});

	assert.equal(results.errors.length, 1);
	assert.equal(results.errorDetails.length, 1);
	assert.equal(results.errorDetails[0].docId, "doc-1");
	assert.match(results.errorDetails[0].message, /boom for doc-1/);
	assert.equal(results.logPath, "reMarkable/_test-sync-log.md");

	const log = files.get(LOG_FILE);
	assert.ok(log, "log file should be written");
	assert.match(log!, /# reMarkable Sync Log/);
	assert.match(log!, /### Errors \(1\)/);
	assert.match(log!, /boom for doc-1/);
	assert.match(log!, /0 synced, 0 skipped, 1 errors/);
});

test("sync does not write a log when writeLog is disabled", async () => {
	const { ops, files } = memoryFileOps();
	const manager = new SyncManager(
		"/vault",
		"reMarkable",
		ops,
		new SyncState()
	);

	const results = await manager.sync(failingClient([doc("doc-1", "Notes")]), {
		writeLog: false,
		logFileName: "_test-sync-log.md",
	});

	assert.equal(results.logPath, null);
	assert.equal(files.has(LOG_FILE), false);
});

test("log keeps history across multiple runs (most recent first)", async () => {
	const { ops, files } = memoryFileOps();
	const manager = new SyncManager(
		"/vault",
		"reMarkable",
		ops,
		new SyncState()
	);

	await manager.sync(failingClient([doc("doc-1", "First")]), {
		logFileName: "_test-sync-log.md",
	});
	await manager.sync(failingClient([doc("doc-2", "Second")]), {
		logFileName: "_test-sync-log.md",
	});

	const log = files.get(LOG_FILE)!;
	// Exactly one header, two run sections.
	assert.equal(log.match(/# reMarkable Sync Log/g)?.length, 1);
	assert.equal(log.match(/## Sync /g)?.length, 2);
	// The second run's error should appear before the first run's error.
	assert.ok(log.indexOf("boom for doc-2") < log.indexOf("boom for doc-1"));
});

test("an unauthenticated client still produces a log before throwing", async () => {
	const { ops, files } = memoryFileOps();
	const manager = new SyncManager(
		"/vault",
		"reMarkable",
		ops,
		new SyncState()
	);
	const client = { isAuthenticated: false } as unknown as RemarkableCloudClient;

	await assert.rejects(
		() => manager.sync(client, { logFileName: "_test-sync-log.md" }),
		/Not authenticated/
	);

	const log = files.get(LOG_FILE);
	assert.ok(log, "log should be written even when not authenticated");
	assert.match(log!, /Not authenticated/);
});

// --- Vault-relative paths (fs -> Vault adapter migration) ---
//
// In Obsidian the plugin now passes an empty base path and writes through the
// vault adapter, so all paths must be vault-relative with NO leading slash.

test("an empty base path produces vault-relative paths (no leading slash)", async () => {
	const { ops, files } = memoryFileOps();
	const manager = new SyncManager("", "reMarkable", ops, new SyncState());

	const results = await manager.sync(failingClient([doc("doc-1", "Notes")]), {
		logFileName: "_test-sync-log.md",
	});

	// Log + state are written vault-relative, not under a "/vault" prefix.
	assert.equal(results.logPath, "reMarkable/_test-sync-log.md");
	assert.ok(files.has("reMarkable/_test-sync-log.md"), "log written vault-relative");
	assert.ok(
		files.has("reMarkable/.remarkable-sync-state.json"),
		"state dotfile written vault-relative"
	);
	// Nothing may be written with a leading slash (would break adapter paths).
	for (const key of files.keys()) {
		assert.ok(!key.startsWith("/"), `path must not start with '/': ${key}`);
	}
});

// --- Change detection (issue #24): `version` is a file count, so edits must be caught via entryHash ---

test("needsSync always syncs a document with no state entry", () => {
	const state = new SyncState();
	assert.equal(state.needsSync(doc("doc-1", "New", 3, "hash-1")), true);
});

test("needsSync detects edits with the same file count but a different entry hash", () => {
	const state = new SyncState();
	state.syncedDocs["doc-1"] = syncedInfo("hash-before-edit");

	// Handwriting added to an existing page: same file count, new entry hash.
	assert.equal(
		state.needsSync(doc("doc-1", "Notes", 5, "hash-after-edit")),
		true
	);
});

test("needsSync skips documents whose entry hash and file count are unchanged", () => {
	const state = new SyncState();
	state.syncedDocs["doc-1"] = syncedInfo("same-hash");

	assert.equal(state.needsSync(doc("doc-1", "Notes", 5, "same-hash")), false);
});

test("needsSync re-syncs when state predates entry-hash tracking", () => {
	const state = new SyncState();
	state.syncedDocs["doc-1"] = syncedInfo();

	// Re-sync once so any previously missed edits get picked up.
	assert.equal(state.needsSync(doc("doc-1", "Notes", 5, "some-hash")), true);
});

test("needsSync falls back to the file-count comparison for synthetic docs without an entry hash", () => {
	const state = new SyncState();
	state.syncedDocs["doc-1"] = syncedInfo();

	// The real client always supplies an entry hash; this covers test/synthetic inputs.
	assert.equal(state.needsSync(doc("doc-1", "Notes", 5)), false);
	assert.equal(state.needsSync(doc("doc-1", "Notes", 6)), true);
});

test("sync re-processes an edited document and still skips an unchanged one", async () => {
	const { ops } = memoryFileOps();
	const state = new SyncState();
	state.syncedDocs["doc-1"] = syncedInfo("hash-before-edit");
	state.syncedDocs["doc-2"] = syncedInfo("same-hash", "reMarkable/Ideas.pdf");
	const manager = new SyncManager("/vault", "reMarkable", ops, state);

	// Both docs keep file count 5; only doc-1's hash changed. The failing
	// client makes the sync attempt visible as an error.
	const results = await manager.sync(
		failingClient([
			doc("doc-1", "Notes", 5, "hash-after-edit"),
			doc("doc-2", "Ideas", 5, "same-hash"),
		]),
		{ writeLog: false }
	);

	assert.equal(results.skipped.length, 1);
	assert.equal(results.errorDetails.length, 1);
	assert.equal(results.errorDetails[0].docId, "doc-1");
});

test("a successful sync persists the entry hash so the next run skips", async () => {
	const { ops, files } = memoryFileOps();
	const manager = new SyncManager("/vault", "reMarkable", ops, new SyncState());
	const client = successClient([doc("doc-1", "Notes", 1, "hash-1")]);

	const first = await manager.sync(client, { writeLog: false });
	assert.equal(first.synced.length, 1);
	assert.equal(first.errors.length, 0);
	assert.ok(files.has("/vault/reMarkable/Notes.pdf"), "PDF written");

	const state = JSON.parse(
		files.get("/vault/reMarkable/.remarkable-sync-state.json")!
	);
	assert.equal(state.synced_docs["doc-1"].entryHash, "hash-1");

	// Fresh manager (reloaded state), unchanged doc: must skip, not re-download.
	const reloaded = await SyncManager.create("/vault", "reMarkable", ops);
	const second = await reloaded.sync(client, { writeLog: false });
	assert.equal(second.skipped.length, 1);
	assert.equal(second.synced.length, 0);
});

test("a re-render that produces identical bytes skips the vault write", async () => {
	const { ops, binaryWrites } = memoryFileOps();
	const manager = new SyncManager("/vault", "reMarkable", ops, new SyncState());

	await manager.sync(successClient([doc("doc-1", "Notes", 1, "hash-1")]), {
		writeLog: false,
	});
	assert.equal(binaryWrites.length, 1);

	// Metadata-only change: new entry hash, same rendered bytes.
	const results = await manager.sync(
		successClient([doc("doc-1", "Notes", 1, "hash-2")]),
		{ writeLog: false }
	);
	assert.equal(results.synced.length, 1);
	assert.equal(binaryWrites.length, 1, "identical PDF must not be rewritten");
});

test("a renamed document moves its PDF instead of leaving a duplicate", async () => {
	const { ops, files } = memoryFileOps();
	const manager = new SyncManager("/vault", "reMarkable", ops, new SyncState());

	await manager.sync(successClient([doc("doc-1", "Notes", 1, "hash-1")]), {
		writeLog: false,
	});
	assert.ok(files.has("/vault/reMarkable/Notes.pdf"));

	// Rename on the device: same content, new name and entry hash.
	await manager.sync(successClient([doc("doc-1", "Meeting", 1, "hash-2")]), {
		writeLog: false,
	});
	assert.ok(files.has("/vault/reMarkable/Meeting.pdf"), "new path written");
	assert.ok(
		!files.has("/vault/reMarkable/Notes.pdf"),
		"old path must be cleaned up"
	);
});

test("dry-run does not touch the sync state file", async () => {
	const { ops, files } = memoryFileOps();
	const manager = new SyncManager("/vault", "reMarkable", ops, new SyncState());

	const results = await manager.sync(
		successClient([doc("doc-1", "Notes", 1, "hash-1")]),
		{ dryRun: true, writeLog: false }
	);

	assert.equal(results.synced.length, 1);
	assert.equal(
		files.has("/vault/reMarkable/.remarkable-sync-state.json"),
		false,
		"dry-run must not write state"
	);
	assert.equal(files.has("/vault/reMarkable/Notes.pdf"), false);
});

test("an empty subfolder writes at the vault root without a leading slash", async () => {
	const { ops, files } = memoryFileOps();
	const manager = new SyncManager("", "", ops, new SyncState());

	await manager.sync(failingClient([doc("doc-1", "Notes")]), {
		logFileName: "_test-sync-log.md",
	});

	assert.ok(files.has("_test-sync-log.md"), "log written at vault root");
	assert.ok(
		files.has(".remarkable-sync-state.json"),
		"state dotfile written at vault root"
	);
	for (const key of files.keys()) {
		assert.ok(!key.startsWith("/"), `path must not start with '/': ${key}`);
	}
});

test("parseFolderList trims entries, strips slashes and drops empties", () => {
	assert.deepEqual(parseFolderList(" Archive , /Work/Old/ ,, "), ["Archive", "Work/Old"]);
	assert.deepEqual(parseFolderList(""), []);
});

test("isInExcludedFolder matches whole path segments only", () => {
	assert.equal(isInExcludedFolder("Work/Notes", ["Work"]), true);
	assert.equal(isInExcludedFolder("Work/Old/Notes", ["Work/Old"]), true);
	assert.equal(isInExcludedFolder("Workouts/Plan", ["Work"]), false);
	assert.equal(isInExcludedFolder("Work", ["Work"]), false);
});

test("sync skips documents inside excluded folders and their subfolders", async () => {
	const { ops } = memoryFileOps();
	const folder = (id: string, name: string, parent = ""): DocumentMetadata => ({
		...doc(id, name),
		parent,
		docType: "CollectionType",
	});
	const inFolder = (id: string, name: string, parent: string): DocumentMetadata => ({
		...doc(id, name),
		parent,
	});
	const manager = new SyncManager("/vault", "reMarkable", ops, new SyncState());

	const results = await manager.sync(
		failingClient([
			folder("f-archive", "Archive"),
			folder("f-nested", "Nested", "f-archive"),
			folder("f-work", "Work"),
			inFolder("d-archived", "Old", "f-archive"),
			inFolder("d-nested", "Deep", "f-nested"),
			inFolder("d-work", "Plan", "f-work"),
			doc("d-root", "Loose"),
		]),
		{ writeLog: false, excludedFolders: ["Archive"] }
	);

	const attempted = results.errorDetails.map((e) => e.docId).sort();
	assert.deepEqual(attempted, ["d-root", "d-work"]);
});
