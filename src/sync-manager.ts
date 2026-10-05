/**
 * Sync Manager
 *
 * Orchestrates syncing from reMarkable cloud to local filesystem.
 * Handles incremental sync, folder structure, and file management.
 * Obsidian-independent via abstracted file I/O.
 */

import {
	RemarkableCloudClient,
	type DocumentMetadata,
	type FileOps,
	buildFolderTree,
	isDocument,
} from "./cloud-client";
import { convertDocument, convertDocumentToMarkdown } from "./document-converter";
import {
	SYNC_LOG_FILENAME,
	SYNC_LOG_MAX_BYTES,
	DEFAULT_OUTPUT_FORMAT,
	type OutputFormat,
} from "./constants";

// --- Sync state ---

export interface SyncedDocInfo {
	/** Sub-file count at last sync (the root index has no real revision number). */
	version: number;
	/** Vault-relative PDF path; "" if a PDF has never been written for this doc. */
	path: string;
	hash: string;
	syncedAt: string;
	/** Root-index entry hash; changes on any edit. Absent in state files from before entry-hash tracking. */
	entryHash?: string;
	/** Vault-relative path of the exported Markdown, if one has been written. */
	markdownPath?: string;
	markdownHash?: string;
}

export class SyncState {
	lastSync: string | null = null;
	syncedDocs: Record<string, SyncedDocInfo> = {};

	static async load(stateFile: string, fileOps: FileOps): Promise<SyncState> {
		const state = new SyncState();
		try {
			const data = await fileOps.readFile(stateFile);
			if (!data) return state;
			const parsed = JSON.parse(data);
			state.lastSync = parsed.last_sync ?? null;
			const docs = parsed.synced_docs;
			// Guard against hand-edited/corrupt state: anything but a plain object resets.
			state.syncedDocs =
				docs && typeof docs === "object" && !Array.isArray(docs) ? docs : {};
		} catch {
			// No state file or invalid JSON
		}
		return state;
	}

	async save(stateFile: string, fileOps: FileOps): Promise<void> {
		const data = JSON.stringify(
			{
				last_sync: this.lastSync,
				synced_docs: this.syncedDocs,
			},
			null,
			2
		);
		await fileOps.writeFile(stateFile, data);
	}

	needsSync(doc: DocumentMetadata): boolean {
		const synced = this.syncedDocs[doc.id];
		if (!synced) return true;
		// The entry hash is authoritative when present: it changes on any edit,
		// while `version` is the sub-file count and misses in-place edits.
		if (doc.entryHash) return synced.entryHash !== doc.entryHash;
		return (synced.version ?? 0) < doc.version;
	}
}

// --- Sync results ---

export interface SyncErrorDetail {
	docId: string;
	path: string;
	message: string;
}

export interface SyncResults {
	synced: string[];
	skipped: string[];
	errors: string[];
	/** Structured per-document failures (richer than the `errors` strings). */
	errorDetails: SyncErrorDetail[];
	/** Timestamped activity lines captured during the run. */
	log: string[];
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	/** Vault-relative path of the log file written for this run, if any. */
	logPath: string | null;
}

export type ProgressCallback = (message: string) => void;

// --- Sync manager ---

export interface SyncOptions {
	folderFilter?: string;
	force?: boolean;
	dryRun?: boolean;
	subfolder?: string;
	onProgress?: ProgressCallback;
	/** Write a human-readable log file into the sync folder (default: true). */
	writeLog?: boolean;
	/** Override the log filename (default: SYNC_LOG_FILENAME). */
	logFileName?: string;
	/** What to write for each document (default: "pdf"). */
	outputFormat?: OutputFormat;
}

export class SyncManager {
	private outputDir: string;
	private stateFile: string;
	private fileOps: FileOps;
	private state: SyncState;
	private vaultPath: string;
	/** Documents present on the tablet in the current run (see isClaimedByOtherDoc). */
	private liveDocIds = new Set<string>();

	constructor(
		vaultPath: string,
		subfolder: string,
		fileOps: FileOps,
		state: SyncState
	) {
		this.vaultPath = vaultPath;
		this.outputDir = joinPath(vaultPath, subfolder);
		this.stateFile = joinPath(this.outputDir, ".remarkable-sync-state.json");
		this.fileOps = fileOps;
		this.state = state;
	}

	static async create(
		vaultPath: string,
		subfolder: string,
		fileOps: FileOps
	): Promise<SyncManager> {
		const outputDir = joinPath(vaultPath, subfolder);
		const stateFile = joinPath(outputDir, ".remarkable-sync-state.json");
		const state = await SyncState.load(stateFile, fileOps);
		return new SyncManager(vaultPath, subfolder, fileOps, state);
	}

	async sync(
		client: RemarkableCloudClient,
		opts: SyncOptions = {}
	): Promise<SyncResults> {
		const startMs = Date.now();
		const results: SyncResults = {
			synced: [],
			skipped: [],
			errors: [],
			errorDetails: [],
			log: [],
			startedAt: new Date().toISOString(),
			finishedAt: "",
			durationMs: 0,
			logPath: null,
		};
		const writeLog = opts.writeLog ?? true;
		const outputFormat = opts.outputFormat ?? DEFAULT_OUTPUT_FORMAT;
		const logFileName = opts.logFileName ?? SYNC_LOG_FILENAME;

		// Capture every progress line into the run log, then forward to the caller.
		const userProgress = opts.onProgress ?? (() => {});
		const progress = (message: string) => {
			results.log.push(`[${new Date().toISOString()}] ${message}`);
			userProgress(message);
		};

		const finalize = async (): Promise<void> => {
			results.finishedAt = new Date().toISOString();
			results.durationMs = Date.now() - startMs;
			if (writeLog) {
				try {
					results.logPath = await this.writeRunLog(results, logFileName);
				} catch (e) {
					// Never let logging failures break a sync.
					userProgress(`(could not write sync log: ${(e as Error).message})`);
				}
			}
		};

		if (!client.isAuthenticated) {
			const message =
				"Not authenticated. Please register with reMarkable first.";
			progress(`[FAIL] ${message}`);
			await finalize();
			throw new Error(message);
		}

		progress("Fetching document list from reMarkable cloud...");
		let documents: DocumentMetadata[];
		try {
			documents = await client.listDocuments();
		} catch (e) {
			const message = (e as Error).message;
			progress(`[FAIL] Could not list documents: ${message}`);
			await finalize();
			throw e;
		}
		const folderPaths = buildFolderTree(documents);

		// Filter to documents only
		const docsToSync = documents.filter(
			(doc) => isDocument(doc) && !doc.isTrashed
		);
		this.liveDocIds = new Set(docsToSync.map((doc) => doc.id));

		// Apply folder filter
		const filtered = opts.folderFilter
			? docsToSync.filter((doc) =>
					(folderPaths.get(doc.id) ?? "").startsWith(opts.folderFilter!)
				)
			: docsToSync;

		progress(`Found ${filtered.length} documents to check`);

		for (const doc of filtered) {
			const docPath = folderPaths.get(doc.id) ?? doc.name;

			if (!opts.force && !this.state.needsSync(doc)) {
				results.skipped.push(docPath);
				continue;
			}

			if (opts.dryRun) {
				progress(`[dry-run] Would sync: ${docPath}`);
				results.synced.push(docPath);
				continue;
			}

			try {
				await this.syncDocument(client, doc, docPath, progress, outputFormat);
				results.synced.push(docPath);
				progress(`[OK] Synced: ${docPath}`);
			} catch (e) {
				const message = (e as Error).message;
				results.errors.push(`${docPath}: ${message}`);
				results.errorDetails.push({
					docId: doc.id,
					path: docPath,
					message,
				});
				progress(`[FAIL] Error: ${docPath}: ${message}`);
			}
		}

		if (!opts.dryRun) {
			this.state.lastSync = new Date().toISOString();
			try {
				await this.state.save(this.stateFile, this.fileOps);
			} catch (e) {
				// Per-doc saves already persisted progress; still finalize and log.
				progress(`[FAIL] Could not save sync state: ${(e as Error).message}`);
			}
		}

		progress(
			`Sync finished — ${results.synced.length} synced, ` +
				`${results.skipped.length} skipped, ${results.errors.length} errors`
		);

		await finalize();

		return results;
	}

	/**
	 * Write a human-readable Markdown log of the latest run into the sync folder.
	 * Keeps a capped history of previous runs so users can troubleshoot failures.
	 * Returns the vault-relative path of the log file.
	 */
	private async writeRunLog(
		results: SyncResults,
		fileName: string
	): Promise<string> {
		const logFilePath = joinPath(this.outputDir, fileName);

		let previous = "";
		try {
			previous = (await this.fileOps.readFile(logFilePath)) ?? "";
		} catch {
			previous = "";
		}
		previous = stripLogHeader(previous).trim();

		const section = formatRunSection(results);
		let body = previous ? section + "\n\n" + previous : section;
		if (body.length > SYNC_LOG_MAX_BYTES) {
			body =
				body.slice(0, SYNC_LOG_MAX_BYTES) +
				"\n\n_…older log entries truncated…_\n";
		}

		const content = LOG_HEADER + body + "\n";

		if (this.outputDir) await this.fileOps.mkdir(this.outputDir);
		await this.fileOps.writeFile(logFilePath, content);

		return logFilePath.startsWith(this.vaultPath + "/")
			? logFilePath.substring(this.vaultPath.length + 1)
			: logFilePath;
	}

	private async syncDocument(
		client: RemarkableCloudClient,
		doc: DocumentMetadata,
		docPath: string,
		progress: ProgressCallback,
		outputFormat: OutputFormat
	): Promise<void> {
		progress(`Downloading: ${docPath}...`);
		const files = await client.downloadDocument(doc.id);

		progress(`Converting: ${docPath}...`);

		// Sanitize path for Windows (backslash included: names must not create folders)
		const safePath = docPath.replace(/[<>:"|?*\\]/g, "_");
		const previous = this.state.syncedDocs[doc.id];

		// Start from the previous record so outputs that are switched off keep
		// their last-known paths (and are left untouched on disk).
		const record: SyncedDocInfo = {
			version: doc.version,
			path: previous?.path ?? "",
			hash: previous?.hash ?? "",
			syncedAt: new Date().toISOString(),
			entryHash: doc.entryHash,
			markdownPath: previous?.markdownPath,
			markdownHash: previous?.markdownHash,
		};

		const writePdf = outputFormat !== "markdown";
		const writeMarkdown = outputFormat === "markdown" || outputFormat === "both";

		if (writePdf) {
			const pdfData = await convertDocument(doc.id, files);
			const written = await this.writeOutput(
				doc.id,
				safePath + ".pdf",
				simpleHash(pdfData),
				{ path: previous?.path, hash: previous?.hash },
				(p) => this.fileOps.writeBinaryFile(p, pdfData),
				progress
			);
			record.path = written.path;
			record.hash = written.hash;
		}

		if (writeMarkdown) {
			const markdown = await convertDocumentToMarkdown(doc.id, files);
			const fileName = safePath + ".md";
			if (markdown === null) {
				// A previously exported .md is deliberately kept: an empty result
				// can't be told apart from a page that failed to parse.
				if (!writePdf) progress(`No typed text in ${docPath}; nothing written.`);
			} else if (!(await this.mayWriteMarkdown(doc.id, fileName, previous?.markdownPath, markdown))) {
				// Users keep their own notes next to synced PDFs; never clobber one.
				progress(
					`Skipped Markdown for ${docPath}: ${fileName} already exists ` +
						`and was not created by reMarkable Sync.`
				);
			} else {
				const written = await this.writeOutput(
					doc.id,
					fileName,
					simpleHash(new TextEncoder().encode(markdown)),
					{ path: previous?.markdownPath, hash: previous?.markdownHash },
					(p) => this.fileOps.writeFile(p, markdown),
					progress
				);
				record.markdownPath = written.path;
				record.markdownHash = written.hash;
			}
		}

		this.state.syncedDocs[doc.id] = record;
		await this.state.save(this.stateFile, this.fileOps);
	}

	/**
	 * Write one output file for a document, skipping the write when the content
	 * hash and path are unchanged, and removing the copy at the previous path
	 * when the document was renamed or moved.
	 */
	private async writeOutput(
		docId: string,
		fileName: string,
		hash: string,
		previous: { path?: string; hash?: string },
		write: (outputPath: string) => Promise<void>,
		progress: ProgressCallback
	): Promise<{ path: string; hash: string }> {
		const outputPath = joinPath(this.outputDir, fileName);
		const relativePath = this.toVaultRelative(outputPath);

		const parentDir = outputPath.substring(0, outputPath.lastIndexOf("/"));
		if (parentDir) await this.fileOps.mkdir(parentDir);

		// Metadata-only changes re-render the same bytes; skip the write to spare
		// vault watchers (Obsidian Sync, backups) a spurious mtime bump.
		const unchanged =
			previous.hash === hash &&
			previous.path === relativePath &&
			(await this.fileOps.exists(outputPath));
		if (!unchanged) {
			await write(outputPath);
		}

		// A rename/move re-syncs to a new path; drop the stale copy at the old one.
		// An empty previous path means this output was never written, and a path
		// another document now owns (e.g. a new document reusing the old name)
		// is no longer ours to delete.
		if (
			previous.path &&
			previous.path !== relativePath &&
			!this.isClaimedByOtherDoc(docId, previous.path)
		) {
			const oldPath = joinPath(this.vaultPath, previous.path);
			try {
				if (await this.fileOps.exists(oldPath)) {
					await this.fileOps.deleteFile(oldPath);
					progress(`Removed old copy: ${previous.path}`);
				}
			} catch (e) {
				progress(`(could not remove old copy ${previous.path}: ${(e as Error).message})`);
			}
		}

		return { path: relativePath, hash };
	}

	/**
	 * True if another document still on the tablet records `relativePath` as
	 * one of its outputs. Entries for trashed/deleted documents are never
	 * pruned from the state, so they don't count.
	 */
	private isClaimedByOtherDoc(docId: string, relativePath: string): boolean {
		return Object.entries(this.state.syncedDocs).some(
			([id, info]) =>
				id !== docId &&
				this.liveDocIds.has(id) &&
				(info.path === relativePath || info.markdownPath === relativePath)
		);
	}

	/**
	 * Whether this document may write its Markdown to `fileName`. Allowed when
	 * the path is free, already this document's, holds identical content (e.g.
	 * after a state reset), or holds another document's export, which is then
	 * handed over. Anything else is a file the user created and is left alone.
	 */
	private async mayWriteMarkdown(
		docId: string,
		fileName: string,
		ownedPath: string | undefined,
		content: string
	): Promise<boolean> {
		const outputPath = joinPath(this.outputDir, fileName);
		const relativePath = this.toVaultRelative(outputPath);
		if (relativePath === ownedPath) return true;
		if (!(await this.fileOps.exists(outputPath))) return true;

		for (const [id, info] of Object.entries(this.state.syncedDocs)) {
			if (id !== docId && info.markdownPath === relativePath) {
				delete info.markdownPath;
				delete info.markdownHash;
				return true;
			}
		}

		return (await this.fileOps.readFile(outputPath)) === content;
	}

	/** Strip the vault prefix so state paths stay portable across vault locations. */
	private toVaultRelative(p: string): string {
		return p.startsWith(this.vaultPath + "/")
			? p.substring(this.vaultPath.length + 1)
			: p;
	}

	async listRemote(
		client: RemarkableCloudClient
	): Promise<
		{ id: string; name: string; path: string; version: number; modified: string; synced: boolean }[]
	> {
		const documents = await client.listDocuments();
		const folderPaths = buildFolderTree(documents);
		const result: { id: string; name: string; path: string; version: number; modified: string; synced: boolean }[] = [];

		for (const doc of documents) {
			if (isDocument(doc) && !doc.isTrashed) {
				result.push({
					id: doc.id,
					name: doc.name,
					path: folderPaths.get(doc.id) ?? doc.name,
					version: doc.version,
					modified: doc.modifiedTime,
					synced: !this.state.needsSync(doc),
				});
			}
		}
		return result;
	}

	get lastSyncTime(): string | null {
		return this.state.lastSync;
	}

	get isAuthenticated(): boolean {
		return false; // Caller should check client.isAuthenticated
	}
}

// --- Log formatting ---

const LOG_HEADER =
	"# reMarkable Sync Log\n\n" +
	"_Auto-generated by the reMarkable Sync plugin. Most recent run first._\n\n";

/** Remove the standard header so previous runs can be re-appended cleanly. */
function stripLogHeader(content: string): string {
	if (content.startsWith(LOG_HEADER)) {
		return content.slice(LOG_HEADER.length);
	}
	// Fall back to dropping the first heading line if present.
	const idx = content.indexOf("## ");
	return idx >= 0 ? content.slice(idx) : content;
}

/** Build the Markdown section for a single sync run. */
function formatRunSection(results: SyncResults): string {
	const seconds = (results.durationMs / 1000).toFixed(1);
	const lines: string[] = [];

	lines.push(`## Sync ${results.startedAt}`);
	lines.push("");
	lines.push(
		`- **Result:** ${results.synced.length} synced, ` +
			`${results.skipped.length} skipped, ${results.errors.length} errors`
	);
	lines.push(`- **Duration:** ${seconds}s`);
	lines.push("");

	if (results.errorDetails.length > 0) {
		lines.push(`### Errors (${results.errorDetails.length})`);
		lines.push("");
		for (const err of results.errorDetails) {
			lines.push(`- \`${err.path}\` — ${err.message}`);
		}
		lines.push("");
	}

	if (results.synced.length > 0) {
		lines.push(`### Synced (${results.synced.length})`);
		lines.push("");
		for (const path of results.synced) {
			lines.push(`- \`${path}\``);
		}
		lines.push("");
	}

	lines.push("<details>");
	lines.push(`<summary>Activity (${results.log.length} lines)</summary>`);
	lines.push("");
	lines.push("```");
	for (const line of results.log) {
		lines.push(line);
	}
	lines.push("```");
	lines.push("");
	lines.push("</details>");
	lines.push("");

	return lines.join("\n");
}

// --- Utilities ---

// Join a base directory and a child path. The base may be empty — used when
// the file ops are vault-relative (Obsidian) — in which case the child is
// returned as-is, avoiding a spurious leading "/". A non-empty base (e.g. the
// CLI's absolute output dir) is joined with a single separator.
function joinPath(base: string, child: string): string {
	if (!base) return child;
	if (!child) return base;
	return base.replace(/\/+$/, "") + "/" + child;
}

function simpleHash(data: Uint8Array): string {
	// Simple FNV-1a hash as a hex string (not cryptographic, just for change detection)
	let hash = 0x811c9dc5;
	for (let i = 0; i < data.length; i++) {
		hash ^= data[i];
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}
