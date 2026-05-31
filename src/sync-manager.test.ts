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
import { SyncManager, SyncState } from "./sync-manager";
import type { DocumentMetadata, FileOps, RemarkableCloudClient } from "./cloud-client";

/** In-memory FileOps that records all writes. */
function memoryFileOps(): { ops: FileOps; files: Map<string, string> } {
	const files = new Map<string, string>();
	const ops: FileOps = {
		readFile: async (p: string) => files.get(p) ?? null,
		writeFile: async (p: string, data: string) => {
			files.set(p, data);
		},
		writeBinaryFile: async (p: string, data: Uint8Array) => {
			files.set(p, `<binary:${data.length}>`);
		},
		mkdir: async () => {},
		exists: async (p: string) => files.has(p),
	};
	return { ops, files };
}

function doc(id: string, name: string, version = 1): DocumentMetadata {
	return {
		id,
		version,
		name,
		parent: "",
		docType: "DocumentType",
		modifiedTime: "",
		pinned: false,
		isTrashed: false,
		entryHash: "",
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
