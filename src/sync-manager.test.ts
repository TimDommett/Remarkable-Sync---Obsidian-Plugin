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
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SyncManager, SyncState } from "./sync-manager";
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

// --- Markdown output ---

/** Raw .rm data of a single-page reference sheet. */
function referencePage(sheet: string): Uint8Array {
	const dir = join(__dirname, "..", "reference_sheets", sheet);
	const rmFile = readdirSync(dir).find((f) => f.endsWith(".rm"));
	assert.ok(rmFile, `${sheet} reference sheet .rm file should exist`);
	return new Uint8Array(readFileSync(join(dir, rmFile)));
}

/**
 * Fake client serving one-page documents built from a reference sheet. The
 * "Text" sheet has typed text in every paragraph style; "Ballpoint" is
 * handwriting only.
 */
function referenceClient(docs: DocumentMetadata[], sheet = "Text"): RemarkableCloudClient {
	const page = referencePage(sheet);
	return {
		isAuthenticated: true,
		listDocuments: async () => docs,
		downloadDocument: async (id: string) =>
			new Map([
				[`${id}.content`, new TextEncoder().encode('{"pages":["p1"]}')],
				[`${id}/p1.rm`, page],
			]),
	} as unknown as RemarkableCloudClient;
}

/** Wrap FileOps to count text writes per path (state/log files included). */
function countTextWrites(ops: FileOps): Map<string, number> {
	const counts = new Map<string, number>();
	const writeFile = ops.writeFile;
	ops.writeFile = async (p: string, data: string) => {
		counts.set(p, (counts.get(p) ?? 0) + 1);
		await writeFile(p, data);
	};
	return counts;
}

test("default output writes only a PDF", async () => {
	const { ops, files } = memoryFileOps();
	const manager = new SyncManager("/vault", "reMarkable", ops, new SyncState());

	await manager.sync(referenceClient([doc("doc-1", "Notes", 1, "hash-1")]), {
		writeLog: false,
	});

	assert.ok(files.has("/vault/reMarkable/Notes.pdf"));
	assert.equal(files.has("/vault/reMarkable/Notes.md"), false);
});

test("'both' writes the PDF and a Markdown file of the typed text", async () => {
	const { ops, files } = memoryFileOps();
	const state = new SyncState();
	const manager = new SyncManager("/vault", "reMarkable", ops, state);

	await manager.sync(referenceClient([doc("doc-1", "Notes", 1, "hash-1")]), {
		writeLog: false,
		outputFormat: "both",
	});

	assert.ok(files.has("/vault/reMarkable/Notes.pdf"));
	const md = files.get("/vault/reMarkable/Notes.md");
	assert.ok(md, "Markdown should be written");
	assert.match(md!, /^# Title\n## Sub Title\nText\n- Bulletpoints\n/);
	assert.equal(state.syncedDocs["doc-1"].path, "reMarkable/Notes.pdf");
	assert.equal(state.syncedDocs["doc-1"].markdownPath, "reMarkable/Notes.md");
});

test("'markdown' writes no PDF and never touches an empty PDF path", async () => {
	const { ops, files, binaryWrites } = memoryFileOps();
	const state = new SyncState();
	const manager = new SyncManager("/vault", "reMarkable", ops, state);

	await manager.sync(referenceClient([doc("doc-1", "Notes", 1, "hash-1")]), {
		writeLog: false,
		outputFormat: "markdown",
	});

	assert.equal(binaryWrites.length, 0);
	assert.ok(files.has("/vault/reMarkable/Notes.md"));
	assert.equal(state.syncedDocs["doc-1"].path, "");

	// Switching to PDF later must not treat the empty path as a stale copy
	// (joinPath(vault, "") is the vault root itself).
	let deletedVaultRoot = false;
	const deleteFile = ops.deleteFile;
	ops.deleteFile = async (p: string) => {
		if (p === "/vault") deletedVaultRoot = true;
		await deleteFile(p);
	};
	files.set("/vault", "<dir>");
	await manager.sync(referenceClient([doc("doc-1", "Notes", 1, "hash-2")]), {
		writeLog: false,
		outputFormat: "pdf",
	});
	assert.equal(deletedVaultRoot, false);
	assert.ok(files.has("/vault/reMarkable/Notes.pdf"));
	assert.ok(files.has("/vault/reMarkable/Notes.md"), "switched-off output is left in place");
	assert.equal(state.syncedDocs["doc-1"].markdownPath, "reMarkable/Notes.md");
});

test("a handwriting-only document gets no Markdown file", async () => {
	const { ops, files } = memoryFileOps();
	const state = new SyncState();
	const manager = new SyncManager("/vault", "reMarkable", ops, state);

	await manager.sync(referenceClient([doc("doc-1", "Sketch", 1, "hash-1")], "Ballpoint"), {
		writeLog: false,
		outputFormat: "both",
	});

	assert.ok(files.has("/vault/reMarkable/Sketch.pdf"));
	assert.equal(files.has("/vault/reMarkable/Sketch.md"), false);
	assert.equal(state.syncedDocs["doc-1"].markdownPath, undefined);
});

test("losing all typed text keeps the previously exported Markdown", async () => {
	const { ops, files } = memoryFileOps();
	const state = new SyncState();
	const manager = new SyncManager("/vault", "reMarkable", ops, state);

	await manager.sync(referenceClient([doc("doc-1", "Notes", 1, "hash-1")]), {
		writeLog: false,
		outputFormat: "both",
	});
	await manager.sync(referenceClient([doc("doc-1", "Notes", 1, "hash-2")], "Ballpoint"), {
		writeLog: false,
		outputFormat: "both",
	});

	assert.ok(files.has("/vault/reMarkable/Notes.md"));
	assert.equal(state.syncedDocs["doc-1"].markdownPath, "reMarkable/Notes.md");
});

test("an existing note the plugin did not write is never overwritten", async () => {
	const { ops, files } = memoryFileOps();
	const state = new SyncState();
	const manager = new SyncManager("/vault", "reMarkable", ops, state);
	files.set("/vault/reMarkable/Notes.md", "my own notes about Notes.pdf");

	const results = await manager.sync(referenceClient([doc("doc-1", "Notes", 1, "hash-1")]), {
		writeLog: false,
		outputFormat: "both",
	});

	assert.equal(files.get("/vault/reMarkable/Notes.md"), "my own notes about Notes.pdf");
	assert.ok(files.has("/vault/reMarkable/Notes.pdf"), "PDF is still synced");
	assert.equal(state.syncedDocs["doc-1"].markdownPath, undefined);
	assert.ok(results.log.some((l) => l.includes("Skipped Markdown for Notes")));
});

test("an existing file with identical content is adopted (e.g. after a state reset)", async () => {
	const first = memoryFileOps();
	await new SyncManager("/vault", "reMarkable", first.ops, new SyncState()).sync(
		referenceClient([doc("doc-1", "Notes", 1, "hash-1")]),
		{ writeLog: false, outputFormat: "markdown" }
	);
	const exported = first.files.get("/vault/reMarkable/Notes.md");
	assert.ok(exported);

	// Fresh state, same file already on disk.
	const { ops, files } = memoryFileOps();
	files.set("/vault/reMarkable/Notes.md", exported!);
	const state = new SyncState();
	await new SyncManager("/vault", "reMarkable", ops, state).sync(
		referenceClient([doc("doc-1", "Notes", 1, "hash-1")]),
		{ writeLog: false, outputFormat: "markdown" }
	);

	assert.equal(state.syncedDocs["doc-1"].markdownPath, "reMarkable/Notes.md");
});

test("unchanged Markdown is not rewritten on re-sync", async () => {
	const { ops } = memoryFileOps();
	const writes = countTextWrites(ops);
	const manager = new SyncManager("/vault", "reMarkable", ops, new SyncState());

	await manager.sync(referenceClient([doc("doc-1", "Notes", 1, "hash-1")]), {
		writeLog: false,
		outputFormat: "markdown",
	});
	await manager.sync(referenceClient([doc("doc-1", "Notes", 1, "hash-2")]), {
		writeLog: false,
		outputFormat: "markdown",
	});

	assert.equal(writes.get("/vault/reMarkable/Notes.md"), 1);
});

test("a renamed document moves its Markdown instead of leaving a duplicate", async () => {
	const { ops, files } = memoryFileOps();
	const manager = new SyncManager("/vault", "reMarkable", ops, new SyncState());

	await manager.sync(referenceClient([doc("doc-1", "Notes", 1, "hash-1")]), {
		writeLog: false,
		outputFormat: "both",
	});
	await manager.sync(referenceClient([doc("doc-1", "Meeting", 1, "hash-2")]), {
		writeLog: false,
		outputFormat: "both",
	});

	assert.ok(files.has("/vault/reMarkable/Meeting.md"));
	assert.ok(files.has("/vault/reMarkable/Meeting.pdf"));
	assert.equal(files.has("/vault/reMarkable/Notes.md"), false);
	assert.equal(files.has("/vault/reMarkable/Notes.pdf"), false);
});

test("a rename never deletes a file another document now owns", async () => {
	const { ops, files } = memoryFileOps();
	const manager = new SyncManager("/vault", "reMarkable", ops, new SyncState());

	await manager.sync(successClient([doc("doc-a", "Notes", 1, "a1")]), { writeLog: false });

	// In one run, A is renamed away and a new document B takes its old name.
	// B syncs first, so A's stale path is B's file by the time A is processed.
	await manager.sync(
		successClient([doc("doc-b", "Notes", 1, "b1"), doc("doc-a", "Old", 1, "a2")]),
		{ writeLog: false }
	);

	assert.ok(files.has("/vault/reMarkable/Old.pdf"));
	assert.ok(files.has("/vault/reMarkable/Notes.pdf"), "doc B's PDF must not be deleted");
});

test("a deleted document's stale entry doesn't block rename cleanup (PDF default)", async () => {
	const { ops, files } = memoryFileOps();
	const manager = new SyncManager("/vault", "reMarkable", ops, new SyncState());

	// X writes Notes.pdf, then is deleted; its state entry lingers.
	await manager.sync(successClient([doc("doc-x", "Notes", 1, "x1")]), { writeLog: false });
	// A new document B reuses the name, then is renamed.
	await manager.sync(successClient([doc("doc-b", "Notes", 1, "b1")]), { writeLog: false });
	await manager.sync(successClient([doc("doc-b", "Other", 1, "b2")]), { writeLog: false });

	assert.ok(files.has("/vault/reMarkable/Other.pdf"));
	assert.equal(files.has("/vault/reMarkable/Notes.pdf"), false, "stale copy removed as before");
});

test("a new document takes over Markdown another document left behind", async () => {
	const { ops, files } = memoryFileOps();
	const state = new SyncState();
	const manager = new SyncManager("/vault", "reMarkable", ops, state);
	const opts = { writeLog: false, outputFormat: "markdown" as const };

	// A exports Notes.md, then loses its typed text and is renamed (Notes.md kept).
	await manager.sync(referenceClient([doc("doc-a", "Notes", 1, "a1")]), opts);
	await manager.sync(referenceClient([doc("doc-a", "Old", 1, "a2")], "Ballpoint"), opts);

	// B, with different text, is named "Notes": the plugin-written file is handed over.
	await manager.sync(referenceClient([doc("doc-b", "Notes", 1, "b1")], "Highlighter"), opts);
	assert.match(files.get("/vault/reMarkable/Notes.md")!, /No sizes/);
	assert.equal(state.syncedDocs["doc-b"].markdownPath, "reMarkable/Notes.md");
	assert.equal(state.syncedDocs["doc-a"].markdownPath, undefined);

	// A regains text: it writes Old.md and leaves B's file alone.
	await manager.sync(referenceClient([doc("doc-a", "Old", 1, "a3")]), opts);
	assert.ok(files.has("/vault/reMarkable/Old.md"));
	assert.match(files.get("/vault/reMarkable/Notes.md")!, /No sizes/);
});
