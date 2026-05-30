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
import { convertDocument } from "./document-converter";

// --- Sync state ---

export interface SyncedDocInfo {
	version: number;
	path: string;
	hash: string;
	syncedAt: string;
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
			state.syncedDocs = parsed.synced_docs ?? {};
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
		return (synced.version ?? 0) < doc.version;
	}
}

// --- Sync results ---

export interface SyncResults {
	synced: string[];
	skipped: string[];
	errors: string[];
}

export type ProgressCallback = (message: string) => void;

// --- Sync manager ---

export interface SyncOptions {
	folderFilter?: string;
	force?: boolean;
	dryRun?: boolean;
	subfolder?: string;
	onProgress?: ProgressCallback;
}

export class SyncManager {
	private outputDir: string;
	private stateFile: string;
	private fileOps: FileOps;
	private state: SyncState;
	private vaultPath: string;

	constructor(
		vaultPath: string,
		subfolder: string,
		fileOps: FileOps,
		state: SyncState
	) {
		this.vaultPath = vaultPath;
		this.outputDir = vaultPath + "/" + subfolder;
		this.stateFile = this.outputDir + "/.remarkable-sync-state.json";
		this.fileOps = fileOps;
		this.state = state;
	}

	static async create(
		vaultPath: string,
		subfolder: string,
		fileOps: FileOps
	): Promise<SyncManager> {
		const outputDir = vaultPath + "/" + subfolder;
		const stateFile = outputDir + "/.remarkable-sync-state.json";
		const state = await SyncState.load(stateFile, fileOps);
		return new SyncManager(vaultPath, subfolder, fileOps, state);
	}

	async sync(
		client: RemarkableCloudClient,
		opts: SyncOptions = {}
	): Promise<SyncResults> {
		const results: SyncResults = { synced: [], skipped: [], errors: [] };
		const progress = opts.onProgress ?? (() => {});

		if (!client.isAuthenticated) {
			throw new Error(
				"Not authenticated. Please register with reMarkable first."
			);
		}

		progress("Fetching document list from reMarkable cloud...");
		const documents = await client.listDocuments();
		const folderPaths = buildFolderTree(documents);

		// Filter to documents only
		const docsToSync = documents.filter(
			(doc) => isDocument(doc) && !doc.isTrashed
		);

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
				await this.syncDocument(client, doc, docPath, progress);
				results.synced.push(docPath);
				progress(`[OK] Synced: ${docPath}`);
			} catch (e) {
				const msg = `${docPath}: ${(e as Error).message}`;
				results.errors.push(msg);
				progress(`[FAIL] Error: ${msg}`);
			}
		}

		this.state.lastSync = new Date().toISOString();
		await this.state.save(this.stateFile, this.fileOps);

		return results;
	}

	private async syncDocument(
		client: RemarkableCloudClient,
		doc: DocumentMetadata,
		docPath: string,
		progress: ProgressCallback
	): Promise<void> {
		progress(`Downloading: ${docPath}...`);
		const zipData = await client.downloadDocument(doc.id);

		progress(`Converting: ${docPath}...`);
		const pdfData = await convertDocument(doc.id, zipData);

		// Sanitize path for Windows
		const safePath = docPath.replace(/[<>:"|?*]/g, "_");
		const outputPath = this.outputDir + "/" + safePath + ".pdf";

		// Ensure parent directory exists
		const parentDir = outputPath.substring(0, outputPath.lastIndexOf("/"));
		await this.fileOps.mkdir(parentDir);

		// Write PDF
		await this.fileOps.writeBinaryFile(outputPath, pdfData);

		// Compute MD5-like hash (simple hash for change detection)
		const hash = simpleHash(pdfData);

		// Relative path from vault root
		const relativePath = outputPath.startsWith(this.vaultPath + "/")
			? outputPath.substring(this.vaultPath.length + 1)
			: outputPath;

		this.state.syncedDocs[doc.id] = {
			version: doc.version,
			path: relativePath,
			hash,
			syncedAt: new Date().toISOString(),
		};
		await this.state.save(this.stateFile, this.fileOps);
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
					synced: doc.id in this.state.syncedDocs,
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

// --- Utilities ---

function simpleHash(data: Uint8Array): string {
	// Simple FNV-1a hash as a hex string (not cryptographic, just for change detection)
	let hash = 0x811c9dc5;
	for (let i = 0; i < data.length; i++) {
		hash ^= data[i];
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

