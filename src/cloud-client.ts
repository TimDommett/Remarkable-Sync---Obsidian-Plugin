/**
 * reMarkable Cloud API Client
 *
 * Handles authentication and document retrieval from the reMarkable cloud.
 * Uses the sync15 (v3) protocol. Pure TypeScript with fetch() — no Obsidian deps.
 */

import JSZip from "jszip";

// --- Constants ---

export const AUTH_HOST = "https://webapp-prod.cloud.remarkable.engineering";
export const SYNC_HOST = "https://internal.cloud.remarkable.com";

// --- Fetch abstraction (native fetch vs Obsidian requestUrl) ---

export interface FetchResponse {
	ok: boolean;
	status: number;
	text(): Promise<string>;
	json(): Promise<any>;
	arrayBuffer(): Promise<ArrayBuffer>;
}

export type FetchFn = (url: string, options?: {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
}) => Promise<FetchResponse>;

// Default: use native fetch
const defaultFetch: FetchFn = async (url, options) => {
	const resp = await fetch(url, options as RequestInit);
	return {
		ok: resp.ok,
		status: resp.status,
		text: () => resp.text(),
		json: () => resp.json(),
		arrayBuffer: () => resp.arrayBuffer(),
	};
};

// --- File I/O abstraction (for testability) ---

export interface FileOps {
	readFile(path: string): Promise<string | null>;
	writeFile(path: string, data: string): Promise<void>;
	writeBinaryFile(path: string, data: Uint8Array): Promise<void>;
	mkdir(path: string): Promise<void>;
	exists(path: string): Promise<boolean>;
}

// --- Token storage ---

export class TokenStore {
	deviceToken: string | null = null;
	userToken: string | null = null;
	userTokenExpiry: Date | null = null;

	private configDir: string;
	private fileOps: FileOps;

	constructor(configDir: string, fileOps: FileOps) {
		this.configDir = configDir;
		this.fileOps = fileOps;
	}

	get tokenPath(): string {
		return this.configDir + "/token.json";
	}

	async load(): Promise<void> {
		try {
			const data = await this.fileOps.readFile(this.tokenPath);
			if (!data) return;
			const parsed = JSON.parse(data);
			this.deviceToken = parsed.device_token ?? null;
			this.userToken = parsed.user_token ?? null;
			if (parsed.user_token_expiry) {
				this.userTokenExpiry = new Date(parsed.user_token_expiry);
			}
		} catch {
			// No token file or invalid JSON
		}
	}

	async save(): Promise<void> {
		await this.fileOps.mkdir(this.configDir);
		const data = JSON.stringify(
			{
				device_token: this.deviceToken,
				user_token: this.userToken,
				user_token_expiry: this.userTokenExpiry?.toISOString() ?? null,
			},
			null,
			2
		);
		await this.fileOps.writeFile(this.tokenPath, data);
	}

	isUserTokenValid(): boolean {
		if (!this.userToken || !this.userTokenExpiry) return false;
		// 1-hour buffer before expiry
		const buffer = 60 * 60 * 1000;
		return Date.now() < this.userTokenExpiry.getTime() - buffer;
	}
}

// --- Document metadata ---

export interface DocumentMetadata {
	id: string;
	version: number;
	name: string;
	parent: string;
	docType: string;
	modifiedTime: string;
	pinned: boolean;
	isTrashed: boolean;
	entryHash: string;
}

function docFromSync15(
	uuid: string,
	version: number,
	entryHash: string,
	metadata: Record<string, any>
): DocumentMetadata {
	return {
		id: uuid,
		version,
		name: metadata.visibleName ?? "Untitled",
		parent: metadata.parent ?? "",
		docType: metadata.type ?? "DocumentType",
		modifiedTime: metadata.lastModified ?? "",
		pinned: metadata.pinned ?? false,
		isTrashed: metadata.deleted ?? false,
		entryHash,
	};
}

export function isFolder(doc: DocumentMetadata): boolean {
	return doc.docType === "CollectionType";
}

export function isDocument(doc: DocumentMetadata): boolean {
	return doc.docType === "DocumentType";
}

// --- Cloud client ---

export class RemarkableCloudClient {
	tokens: TokenStore;
	private docFileIndex: Map<string, [string, string][]> = new Map();
	private fetchFn: FetchFn;

	constructor(configDir: string, fileOps: FileOps, fetchFn?: FetchFn) {
		this.tokens = new TokenStore(configDir, fileOps);
		this.fetchFn = fetchFn ?? defaultFetch;
	}

	async init(): Promise<void> {
		await this.tokens.load();
	}

	get isAuthenticated(): boolean {
		return this.tokens.deviceToken !== null;
	}

	async registerDevice(oneTimeCode: string): Promise<boolean> {
		const url = `${AUTH_HOST}/token/json/2/device/new`;
		const payload = {
			code: oneTimeCode,
			deviceDesc: "desktop-windows",
			deviceID: generateUUID(),
		};

		const response = await this.fetchFn(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});

		if (response.ok) {
			this.tokens.deviceToken = await response.text();
			await this.tokens.save();
			return true;
		}
		return false;
	}

	async refreshUserToken(): Promise<boolean> {
		if (!this.tokens.deviceToken) {
			throw new Error("No device token. Please register first.");
		}

		const url = `${AUTH_HOST}/token/json/2/user/new`;
		const response = await this.fetchFn(url, {
			method: "POST",
			headers: { Authorization: `Bearer ${this.tokens.deviceToken}` },
		});

		if (response.ok) {
			this.tokens.userToken = await response.text();
			this.tokens.userTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
			await this.tokens.save();
			return true;
		}
		return false;
	}

	private async ensureAuthenticated(forceRefresh = false): Promise<void> {
		if (forceRefresh || !this.tokens.isUserTokenValid()) {
			const success = await this.refreshUserToken();
			if (!success) {
				throw new Error("Failed to authenticate. Please re-register your device.");
			}
		}
	}

	private authHeaders(): Record<string, string> {
		return { Authorization: `Bearer ${this.tokens.userToken}` };
	}

	private async fetchFile(fileHash: string): Promise<Uint8Array> {
		const url = `${SYNC_HOST}/sync/v3/files/${fileHash}`;
		const response = await this.fetchFn(url, { headers: this.authHeaders() });
		if (!response.ok) {
			throw new Error(`Failed to fetch file ${fileHash}: HTTP ${response.status}`);
		}
		return new Uint8Array(await response.arrayBuffer());
	}

	private async fetchRootIndex(): Promise<
		{ hash: string; flags: string; uuid: string; version: number; size: number }[]
	> {
		const url = `${SYNC_HOST}/sync/v3/root`;
		let response = await this.fetchFn(url, { headers: this.authHeaders() });
		if (response.status === 401) {
			// Token rejected by server — force refresh and retry
			await this.ensureAuthenticated(true);
			response = await this.fetchFn(url, { headers: this.authHeaders() });
		}
		if (!response.ok) {
			throw new Error(`Failed to fetch root: HTTP ${response.status}`);
		}
		const root = await response.json();

		const rootHash = root.hash;
		const indexData = await this.fetchFile(rootHash);
		const indexText = new TextDecoder().decode(indexData);

		const lines = indexText.trim().split("\n");
		const entries: { hash: string; flags: string; uuid: string; version: number; size: number }[] = [];

		for (const line of lines.slice(1)) {
			const parts = line.split(":");
			if (parts.length >= 5) {
				entries.push({
					hash: parts[0],
					flags: parts[1],
					uuid: parts[2],
					version: parseInt(parts[3], 10),
					size: parseInt(parts[4], 10),
				});
			}
		}
		return entries;
	}

	// Parse an index file returned by /sync/v3/files/{ref}.
	// Schema v4 format:
	//   line 1:    schema version (e.g. "4")
	//   4-part lines: flags:uuid:version:size  → document UUID identifier, skip
	//   5-part lines: hash:flags:filename:version:size  → actual content file
	private async fetchDocSubIndex(ref: string): Promise<[string, string][]> {
		const data = await this.fetchFile(ref);
		const text = new TextDecoder().decode(data);
		const files: [string, string][] = [];

		for (const line of text.trim().split("\n").slice(1)) {
			const parts = line.trim().split(":");
			// 5-part file entry: hash:flags:filename:version:size
			// Skip 4-part UUID-reference lines (flags:uuid:version:size)
			if (parts.length >= 5 && parts[0].length > 4) {
				const hash = parts[0];
				const filename = parts[2];
				if (filename) files.push([filename, hash]);
			}
		}
		return files;
	}

	async listDocuments(): Promise<DocumentMetadata[]> {
		await this.ensureAuthenticated();

		const entries = await this.fetchRootIndex();
		const documents: DocumentMetadata[] = [];

		for (const entry of entries) {
			const subFiles = await this.fetchDocSubIndex(entry.hash);
			this.docFileIndex.set(entry.uuid, subFiles);

			let metadata: Record<string, any> = {};
			for (const [filename, fileHash] of subFiles) {
				if (filename.endsWith(".metadata")) {
					const metaData = await this.fetchFile(fileHash);
					metadata = JSON.parse(new TextDecoder().decode(metaData));
					break;
				}
			}

			documents.push(
				docFromSync15(entry.uuid, entry.version, entry.hash, metadata)
			);
		}

		return documents;
	}

	async downloadDocument(docId: string): Promise<Uint8Array> {
		await this.ensureAuthenticated();

		if (!this.docFileIndex.has(docId)) {
			const entries = await this.fetchRootIndex();
			let found = false;
			for (const entry of entries) {
				if (entry.uuid === docId) {
					const subFiles = await this.fetchDocSubIndex(entry.hash);
					this.docFileIndex.set(docId, subFiles);
					found = true;
					break;
				}
			}
			if (!found) throw new Error(`Document not found: ${docId}`);
		}

		const subFiles = this.docFileIndex.get(docId)!;
		const zip = new JSZip();

		for (const [filename, fileHash] of subFiles) {
			const fileData = await this.fetchFile(fileHash);
			zip.file(filename, fileData);
		}

		return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
	}
}

// --- Folder tree ---

export function buildFolderTree(
	documents: DocumentMetadata[]
): Map<string, string> {
	const byId = new Map<string, DocumentMetadata>();
	for (const doc of documents) byId.set(doc.id, doc);

	const paths = new Map<string, string>();

	function getPath(doc: DocumentMetadata): string {
		const cached = paths.get(doc.id);
		if (cached !== undefined) return cached;

		if (!doc.parent || doc.parent === "" || doc.parent === "trash") {
			paths.set(doc.id, doc.name);
			return doc.name;
		}

		const parent = byId.get(doc.parent);
		if (parent) {
			const parentPath = getPath(parent);
			const fullPath = `${parentPath}/${doc.name}`;
			paths.set(doc.id, fullPath);
			return fullPath;
		}

		paths.set(doc.id, doc.name);
		return doc.name;
	}

	for (const doc of documents) {
		if (!doc.isTrashed) getPath(doc);
	}

	return paths;
}

// --- Utilities ---

function generateUUID(): string {
	// crypto.randomUUID available in Node 19+ and modern browsers
	if (typeof crypto !== "undefined" && crypto.randomUUID) {
		return crypto.randomUUID();
	}
	// Fallback
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}
