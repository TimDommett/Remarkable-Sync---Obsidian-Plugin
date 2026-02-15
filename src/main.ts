import { FileSystemAdapter, Notice, Plugin, requestUrl } from "obsidian";
import { RemarkableSyncSettings, DEFAULT_SETTINGS, RemarkableSyncSettingTab } from "./settings";
import { RemarkableCloudClient, type FileOps, type FetchFn, type FetchResponse } from "./cloud-client";
import { SyncManager } from "./sync-manager";
import { SYNC_INTERVALS } from "./constants";
import * as path from "path";
import * as fs from "fs";

export default class RemarkableSyncPlugin extends Plugin {
	settings: RemarkableSyncSettings = DEFAULT_SETTINGS;
	private client!: RemarkableCloudClient;
	private syncIntervalId: number | null = null;
	private statusBarItem: HTMLElement | null = null;
	private isSyncing = false;

	async onload(): Promise<void> {
		await this.loadSettings();

		// Initialize cloud client with Node.js file ops + Obsidian fetch
		const configDir = this.getConfigDir();
		this.client = new RemarkableCloudClient(configDir, this.getFileOps(), this.getObsidianFetch());
		await this.client.init();

		// Update auth status from token store
		this.settings.isAuthenticated = this.client.isAuthenticated;

		// Ribbon icon for manual sync
		this.addRibbonIcon("refresh-cw", "Sync reMarkable", async () => {
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
			id: "open-settings",
			name: "Open reMarkable Sync settings",
			callback: () => {
				const setting = (this.app as any).setting;
				setting.open();
				setting.openTabById(this.manifest.id);
			},
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

	private getVaultPath(): string {
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			return adapter.getBasePath();
		}
		throw new Error("Cannot determine vault path. This plugin requires desktop Obsidian.");
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

	private getFileOps(): FileOps {
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
		this.updateStatusBar("syncing...");
		new Notice("reMarkable: Starting sync...");

		try {
			const vaultPath = this.getVaultPath();
			const fileOps = this.getFileOps();
			const manager = await SyncManager.create(
				vaultPath,
				this.settings.subfolder,
				fileOps
			);

			const results = await manager.sync(this.client, {
				folderFilter: this.settings.folderFilter || undefined,
				force,
			});

			this.settings.lastSyncTime = new Date().toISOString();
			await this.saveSettings();

			if (results.errors.length > 0) {
				new Notice(
					`reMarkable sync completed with errors.\n` +
					`Synced: ${results.synced.length}, Skipped: ${results.skipped.length}, Errors: ${results.errors.length}`,
					10000
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
			this.updateStatusBar();
		}
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
