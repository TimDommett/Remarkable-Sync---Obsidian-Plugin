import { Notice, Plugin, TFile, normalizePath, requestUrl } from "obsidian";
import { RemarkableSyncSettings, DEFAULT_SETTINGS, RemarkableSyncSettingTab } from "./settings";
import { RemarkableCloudClient, type FileOps, type FetchFn, type FetchResponse } from "./cloud-client";
import { SyncManager } from "./sync-manager";
import { SYNC_INTERVALS, SYNC_LOG_FILENAME } from "./constants";
import * as path from "path";
import * as fs from "fs";

export default class RemarkableSyncPlugin extends Plugin {
	settings: RemarkableSyncSettings = DEFAULT_SETTINGS;
	private client!: RemarkableCloudClient;
	private syncIntervalId: number | null = null;
	private statusBarItem: HTMLElement | null = null;
	private ribbonIconEl: HTMLElement | null = null;
	private isSyncing = false;

	async onload(): Promise<void> {
		await this.loadSettings();

		// Initialize cloud client with Node.js file ops + Obsidian fetch.
		// The token store lives OUTSIDE the vault (~/.remarkable-sync), so it
		// uses raw fs rather than the vault adapter.
		const configDir = this.getConfigDir();
		this.client = new RemarkableCloudClient(configDir, this.getTokenFileOps(), this.getObsidianFetch());
		await this.client.init();

		// Update auth status from token store
		this.settings.isAuthenticated = this.client.isAuthenticated;

		// Ribbon icon for manual sync (spins while a sync is in progress)
		this.ribbonIconEl = this.addRibbonIcon("refresh-cw", "Sync reMarkable", async () => {
			await this.runSync();
		});

		// Status bar
		this.statusBarItem = this.addStatusBarItem();
		this.updateStatusBar();

		// Commands
		this.addCommand({
			id: "sync-now",
			name: "Sync documents now",
			callback: () => this.runSync(),
		});

		this.addCommand({
			id: "force-sync",
			name: "Force re-sync all documents",
			callback: () => this.runSync(true),
		});

		this.addCommand({
			id: "check-status",
			name: "Check sync status",
			callback: () => this.refreshAuthStatus(),
		});

		this.addCommand({
			id: "open-sync-log",
			name: "Open sync log",
			callback: () => this.openSyncLog(),
		});

		// Settings tab
		this.addSettingTab(new RemarkableSyncSettingTab(this.app, this));

		// Start auto-sync if configured
		this.restartAutoSync();
	}

	onunload(): void {
		this.stopAutoSync();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private getConfigDir(): string {
		const home = process.env.HOME || process.env.USERPROFILE || "";
		return path.join(home, ".remarkable-sync");
	}

	private getObsidianFetch(): FetchFn {
		return async (url, options) => {
			const result = await requestUrl({
				url,
				method: options?.method ?? "GET",
				headers: options?.headers,
				body: options?.body,
				throw: false, // Don't throw on non-2xx — we handle status ourselves
			});
			return {
				ok: result.status >= 200 && result.status < 300,
				status: result.status,
				text: async () => typeof result.text === "string" ? result.text : new TextDecoder().decode(result.arrayBuffer),
				json: async () => result.json,
				arrayBuffer: async () => result.arrayBuffer,
			} as FetchResponse;
		};
	}

	// File ops for the auth token store, which lives OUTSIDE the vault at
	// ~/.remarkable-sync (secrets must never be written into the vault). Uses
	// raw Node fs with absolute paths; desktop-only, which is fine since the
	// plugin is isDesktopOnly.
	private getTokenFileOps(): FileOps {
		return {
			async readFile(filePath: string): Promise<string | null> {
				try {
					return fs.readFileSync(filePath, "utf-8");
				} catch {
					return null;
				}
			},
			async writeFile(filePath: string, data: string): Promise<void> {
				const dir = path.dirname(filePath);
				fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(filePath, data, "utf-8");
			},
			async writeBinaryFile(filePath: string, data: Uint8Array): Promise<void> {
				const dir = path.dirname(filePath);
				fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(filePath, data);
			},
			async mkdir(dirPath: string): Promise<void> {
				fs.mkdirSync(dirPath, { recursive: true });
			},
			async exists(filePath: string): Promise<boolean> {
				return fs.existsSync(filePath);
			},
		};
	}

	// File ops backed by Obsidian's vault adapter, operating on VAULT-RELATIVE
	// paths. Used for everything written inside the vault (synced PDFs, the sync
	// log, and the sync-state dotfile) so Obsidian's file cache, search, and
	// Sync pick the files up immediately — unlike raw fs writes, which bypass
	// the indexer. The sync-state file is a dotfile, which the high-level Vault
	// API does not track, so the adapter (which handles dotfiles transparently)
	// is used uniformly for all three.
	private getVaultFileOps(): FileOps {
		const adapter = this.app.vault.adapter;

		// adapter.mkdir is not reliably recursive across platforms and can throw
		// if the folder already exists, so create each missing ancestor.
		const ensureDir = async (dir: string): Promise<void> => {
			if (!dir || dir === "/" || dir === ".") return;
			if (await adapter.exists(dir)) return;
			const slash = dir.lastIndexOf("/");
			if (slash > 0) await ensureDir(dir.substring(0, slash));
			if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
		};
		const ensureParent = async (filePath: string): Promise<void> => {
			const slash = filePath.lastIndexOf("/");
			if (slash > 0) await ensureDir(filePath.substring(0, slash));
		};

		return {
			async readFile(filePath: string): Promise<string | null> {
				const p = normalizePath(filePath);
				// adapter.read throws when the file is missing; fs returned null,
				// and callers (SyncState.load, writeRunLog) rely on null/empty.
				return (await adapter.exists(p)) ? adapter.read(p) : null;
			},
			async writeFile(filePath: string, data: string): Promise<void> {
				const p = normalizePath(filePath);
				await ensureParent(p);
				await adapter.write(p, data);
			},
			async writeBinaryFile(filePath: string, data: Uint8Array): Promise<void> {
				const p = normalizePath(filePath);
				await ensureParent(p);
				await adapter.writeBinary(p, toArrayBuffer(data));
			},
			async mkdir(dirPath: string): Promise<void> {
				await ensureDir(normalizePath(dirPath));
			},
			async exists(filePath: string): Promise<boolean> {
				return adapter.exists(normalizePath(filePath));
			},
		};
	}

	async registerDevice(code: string): Promise<boolean> {
		const success = await this.client.registerDevice(code);
		if (success) {
			await this.client.refreshUserToken();
		}
		return success;
	}

	async refreshAuthStatus(): Promise<void> {
		await this.client.init(); // Reload tokens from disk
		this.settings.isAuthenticated = this.client.isAuthenticated;

		if (this.client.isAuthenticated && !this.client.tokens.isUserTokenValid()) {
			try {
				const refreshed = await this.client.refreshUserToken();
				if (refreshed) {
					new Notice("reMarkable: Connected. Token refreshed.", 5000);
				} else {
					this.settings.isAuthenticated = false;
					new Notice("reMarkable: Token refresh failed. Please re-register.", 5000);
				}
			} catch {
				this.settings.isAuthenticated = false;
				new Notice("reMarkable: Token refresh failed. Please re-register.", 5000);
			}
		} else if (this.client.isAuthenticated) {
			new Notice("reMarkable: Connected.", 5000);
		} else {
			new Notice("reMarkable: Not authenticated. Please register in settings.");
		}

		await this.saveSettings();
	}

	async runSync(force = false): Promise<void> {
		if (this.isSyncing) {
			new Notice("reMarkable sync is already running.");
			return;
		}

		if (!this.settings.isAuthenticated) {
			new Notice("Please authenticate with reMarkable first. Open plugin settings.");
			return;
		}

		this.isSyncing = true;
		this.setRibbonSpinning(true);
		this.updateStatusBar("syncing...");
		new Notice("reMarkable: Starting sync...");

		try {
			// Write through the vault adapter using vault-relative paths (empty
			// base = the vault root), so synced files are visible to Obsidian
			// immediately.
			const manager = await SyncManager.create(
				"",
				this.settings.subfolder,
				this.getVaultFileOps()
			);

			const results = await manager.sync(this.client, {
				folderFilter: this.settings.folderFilter || undefined,
				force,
				writeLog: this.settings.writeSyncLog,
				logFileName: SYNC_LOG_FILENAME,
			});

			this.settings.lastSyncTime = new Date().toISOString();
			await this.saveSettings();

			if (results.errors.length > 0) {
				// Surface the first few error messages directly so users get
				// immediate, actionable detail without opening the log.
				const preview = results.errors
					.slice(0, 3)
					.map((e) => `• ${e}`)
					.join("\n");
				const more =
					results.errors.length > 3
						? `\n…and ${results.errors.length - 3} more.`
						: "";
				const logHint = this.settings.writeSyncLog
					? `\nSee "${SYNC_LOG_FILENAME}" for full details.`
					: "";
				new Notice(
					`reMarkable sync completed with errors.\n` +
					`Synced: ${results.synced.length}, Skipped: ${results.skipped.length}, Errors: ${results.errors.length}\n` +
					`${preview}${more}${logHint}`,
					15000
				);
			} else if (results.synced.length > 0) {
				new Notice(
					`reMarkable: Synced ${results.synced.length} document(s). ${results.skipped.length} unchanged.`
				);
			} else {
				new Notice("reMarkable: Everything up to date.");
			}
		} catch (err) {
			const message = (err as Error).message;
			if (message.includes("Not authenticated")) {
				this.settings.isAuthenticated = false;
				await this.saveSettings();
			}
			new Notice(`reMarkable sync failed: ${message}`, 10000);
		} finally {
			this.isSyncing = false;
			this.setRibbonSpinning(false);
			this.updateStatusBar();
		}
	}

	async openSyncLog(): Promise<void> {
		// normalizePath guards against a malformed subfolder (empty -> leading
		// slash, trailing slash, backslashes) that would break the lookup.
		const relPath = normalizePath(`${this.settings.subfolder}/${SYNC_LOG_FILENAME}`);

		// Fast path: the log is already in Obsidian's file cache.
		let file = this.app.vault.getAbstractFileByPath(relPath);

		// Slow path: the log was just written through the vault adapter and
		// Obsidian may not have indexed it yet (the file watcher registers it a
		// tick later). Confirm it exists on disk, then wait briefly for the cache
		// to catch up. We deliberately avoid workspace.openLinkText here: it
		// resolves via the metadata cache and would CREATE a stray note if the
		// file isn't indexed yet.
		if (!(file instanceof TFile) && (await this.app.vault.adapter.exists(relPath))) {
			for (let i = 0; i < 20 && !(file instanceof TFile); i++) {
				await delay(25);
				file = this.app.vault.getAbstractFileByPath(relPath);
			}
		}

		if (file instanceof TFile) {
			await this.app.workspace.getLeaf(true).openFile(file);
			return;
		}

		new Notice(
			"No sync log found yet. Run a sync first (with 'Write sync log' enabled)."
		);
	}

	private setRibbonSpinning(active: boolean): void {
		this.ribbonIconEl?.toggleClass("remarkable-sync-spinning", active);
	}

	private updateStatusBar(override?: string): void {
		if (!this.statusBarItem) return;

		if (override) {
			this.statusBarItem.setText(`reMarkable: ${override}`);
			return;
		}

		if (this.settings.lastSyncTime) {
			const date = new Date(this.settings.lastSyncTime);
			const timeStr = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
			this.statusBarItem.setText(`reMarkable: ${timeStr}`);
		} else {
			this.statusBarItem.setText("reMarkable: Not synced");
		}
	}

	restartAutoSync(): void {
		this.stopAutoSync();
		const intervalMs = SYNC_INTERVALS[this.settings.syncIntervalLabel];
		if (intervalMs && intervalMs > 0) {
			this.syncIntervalId = window.setInterval(() => {
				this.runSync();
			}, intervalMs);
			this.registerInterval(this.syncIntervalId);
		}
	}

	private stopAutoSync(): void {
		if (this.syncIntervalId !== null) {
			window.clearInterval(this.syncIntervalId);
			this.syncIntervalId = null;
		}
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// Copy a Uint8Array view into a standalone ArrayBuffer for adapter.writeBinary.
// Using `data.buffer` directly would write the view's entire backing buffer,
// which may be larger than the view (corrupting/padding the output).
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
	return data.buffer.slice(
		data.byteOffset,
		data.byteOffset + data.byteLength
	) as ArrayBuffer;
}
