import { App, Notice, PluginSettingTab, Setting, type SettingDefinitionItem, type TextComponent } from "obsidian";
import type RemarkableSyncPlugin from "./main";
import { SYNC_INTERVALS, AUTH_URL, DEFAULT_SUBFOLDER, SYNC_LOG_FILENAME } from "./constants";

export interface RemarkableSyncSettings {
	subfolder: string;
	syncIntervalLabel: string;
	folderFilter: string;
	excludedFolders: string;
	lastSyncTime: string;
	isAuthenticated: boolean;
	writeSyncLog: boolean;
}

export const DEFAULT_SETTINGS: RemarkableSyncSettings = {
	subfolder: DEFAULT_SUBFOLDER,
	syncIntervalLabel: "Manual only",
	folderFilter: "",
	excludedFolders: "",
	lastSyncTime: "",
	isAuthenticated: false,
	writeSyncLog: true,
};

/**
 * Settings tab with dual support (Obsidian's "Path B"):
 * - Obsidian 1.13+ renders it from getSettingDefinitions(), which also makes
 *   every setting findable in Obsidian's settings search.
 * - Older versions (minAppVersion is below 1.13) call display().
 *
 * Both paths build every row with the same builder methods below, so the two
 * cannot drift apart: add or change a setting in one builder and list it in
 * both getSettingDefinitions() and display().
 */
export class RemarkableSyncSettingTab extends PluginSettingTab {
	plugin: RemarkableSyncPlugin;

	// Rows refreshed in place when the connection status changes.
	private statusSetting: Setting | null = null;
	private authCodeSetting: Setting | null = null;

	constructor(app: App, plugin: RemarkableSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: "group",
				heading: "Authentication",
				items: [
					{ name: "Connection status", render: (s) => this.buildConnectionStatus(s) },
					{ name: "One-time code", render: (s) => this.buildOneTimeCode(s) },
					{ name: "Get a one-time code", render: (s) => this.buildOneTimeCodeLink(s) },
				],
			},
			{
				type: "group",
				heading: "Sync",
				items: [
					{ name: "Subfolder", render: (s) => this.buildSubfolder(s) },
					{ name: "Folder filter", render: (s) => this.buildFolderFilter(s) },
					{ name: "Excluded folders", render: (s) => this.buildExcludedFolders(s) },
					{ name: "Auto-sync interval", render: (s) => this.buildSyncInterval(s) },
				],
			},
			{
				type: "group",
				heading: "Status",
				items: [
					{ name: "Last sync", render: (s) => this.buildLastSync(s) },
					{ name: "Check status", render: (s) => this.buildCheckStatus(s) },
				],
			},
			{
				type: "group",
				heading: "Troubleshooting",
				items: [
					{ name: "Write sync log", render: (s) => this.buildWriteSyncLog(s) },
					{ name: "Open sync log", render: (s) => this.buildOpenSyncLog(s) },
				],
			},
			{
				type: "group",
				heading: "Support",
				items: [
					{
						name: "Support development",
						render: (s) => {
							s.setName("Support development");
							this.buildDonate(s.controlEl);
						},
					},
				],
			},
		];
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// --- Authentication ---
		new Setting(containerEl).setName("Authentication").setHeading();
		this.buildConnectionStatus(new Setting(containerEl));
		this.buildOneTimeCode(new Setting(containerEl));
		const linkEl = containerEl.createEl("p");
		linkEl.createEl("a", {
			text: "Get your one-time code here",
			href: AUTH_URL,
		});

		// --- Sync ---
		new Setting(containerEl).setName("Sync").setHeading();
		this.buildSubfolder(new Setting(containerEl));
		this.buildFolderFilter(new Setting(containerEl));
		this.buildExcludedFolders(new Setting(containerEl));
		this.buildSyncInterval(new Setting(containerEl));

		// --- Status ---
		new Setting(containerEl).setName("Status").setHeading();
		this.buildLastSync(new Setting(containerEl));
		this.buildCheckStatus(new Setting(containerEl));

		// --- Troubleshooting ---
		new Setting(containerEl).setName("Troubleshooting").setHeading();
		this.buildWriteSyncLog(new Setting(containerEl));
		this.buildOpenSyncLog(new Setting(containerEl));

		// --- Support ---
		new Setting(containerEl).setName("Support").setHeading();
		this.buildDonate(containerEl);
	}

	// --- Authentication rows ---

	private buildConnectionStatus(setting: Setting): void {
		this.statusSetting = setting;
		this.renderConnectionStatus();
	}

	private renderConnectionStatus(): void {
		const setting = this.statusSetting;
		if (!setting) return;
		const isAuth = this.plugin.settings.isAuthenticated;
		setting
			.setName(isAuth ? "Connected" : "Not connected")
			.setDesc(isAuth
				? "Authenticated with reMarkable cloud."
				: "Enter a one-time code below to register."
			);
		setting.nameEl.prepend(
			createSpan({
				cls: [
					"remarkable-sync-dot",
					isAuth ? "remarkable-sync-dot-connected" : "remarkable-sync-dot-disconnected",
				],
			})
		);
	}

	private renderOneTimeCodeDesc(): void {
		this.authCodeSetting?.setDesc(
			this.plugin.settings.isAuthenticated
				? "Already connected. Only use this to re-register with a new code."
				: "Get a code from my.remarkable.com, paste it here, and click register."
		);
	}

	// After registering or checking, update the connection rows in place (the
	// imperative tab used to re-render everything with display()).
	private refreshConnectionRows(): void {
		this.renderConnectionStatus();
		this.renderOneTimeCodeDesc();
	}

	private buildOneTimeCode(setting: Setting): void {
		this.authCodeSetting = setting;
		let authCodeValue = "";
		let codeInput: TextComponent | null = null;
		setting
			.setName("One-time code")
			.addText((text) => {
				codeInput = text;
				text.setPlaceholder("abcde-fghij").onChange((value) => {
					authCodeValue = value;
				});
			})
			.addButton((btn) =>
				btn
					.setButtonText("Register")
					.setCta()
					.onClick(async () => {
						if (!authCodeValue.trim()) {
							new Notice("Please enter an auth code.");
							return;
						}
						btn.setButtonText("Registering...");
						btn.setDisabled(true);
						try {
							const success = await this.plugin.registerDevice(authCodeValue.trim());
							if (success) {
								this.plugin.settings.isAuthenticated = true;
								await this.plugin.saveSettings();
								new Notice("Authentication successful.");
								authCodeValue = "";
								codeInput?.setValue("");
								this.refreshConnectionRows(); // Show green status
							} else {
								new Notice("Authentication failed. Check your code and try again.");
							}
						} catch (err) {
							new Notice("Authentication error: " + (err as Error).message);
						}
						btn.setButtonText("Register");
						btn.setDisabled(false);
					})
			);
		this.renderOneTimeCodeDesc();
	}

	private buildOneTimeCodeLink(setting: Setting): void {
		setting.setName("Get a one-time code").setDesc(
			createFragment((frag) => {
				frag.createEl("a", { text: "Get your one-time code here", href: AUTH_URL });
			})
		);
	}

	// --- Sync rows ---

	private buildSubfolder(setting: Setting): void {
		setting
			.setName("Subfolder")
			.setDesc("Subfolder within your vault where synced documents are saved.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SUBFOLDER)
					.setValue(this.plugin.settings.subfolder)
					.onChange(async (value) => {
						this.plugin.settings.subfolder = value || DEFAULT_SUBFOLDER;
						await this.plugin.saveSettings();
					})
			);
	}

	private buildFolderFilter(setting: Setting): void {
		setting
			.setName("Folder filter")
			.setDesc("Only sync documents from this reMarkable folder. Leave empty for all.")
			.addText((text) =>
				text
					.setPlaceholder("e.g., Work Notes")
					.setValue(this.plugin.settings.folderFilter)
					.onChange(async (value) => {
						this.plugin.settings.folderFilter = value;
						await this.plugin.saveSettings();
					})
			);
	}

	private buildExcludedFolders(setting: Setting): void {
		setting
			.setName("Excluded folders")
			.setDesc("Comma-separated reMarkable folders to skip, including their subfolders. Use full paths for nested folders.")
			.addText((text) =>
				text
					.setPlaceholder("e.g., Archive, Work/Old")
					.setValue(this.plugin.settings.excludedFolders)
					.onChange(async (value) => {
						this.plugin.settings.excludedFolders = value;
						await this.plugin.saveSettings();
					})
			);
	}

	private buildSyncInterval(setting: Setting): void {
		setting
			.setName("Auto-sync interval")
			.setDesc("How often to automatically sync documents from your reMarkable.")
			.addDropdown((dropdown) => {
				for (const label of Object.keys(SYNC_INTERVALS)) {
					dropdown.addOption(label, label);
				}
				dropdown.setValue(this.plugin.settings.syncIntervalLabel);
				dropdown.onChange(async (value) => {
					this.plugin.settings.syncIntervalLabel = value;
					await this.plugin.saveSettings();
					this.plugin.restartAutoSync();
				});
			});
	}

	// --- Status rows ---

	private buildLastSync(setting: Setting): void {
		setting
			.setName("Last sync")
			.setDesc(
				this.plugin.settings.lastSyncTime
					? new Date(this.plugin.settings.lastSyncTime).toLocaleString()
					: "Never"
			);
	}

	private buildCheckStatus(setting: Setting): void {
		setting
			.setName("Check status")
			.setDesc("Check current authentication status.")
			.addButton((btn) =>
				btn.setButtonText("Check").onClick(async () => {
					await this.plugin.refreshAuthStatus();
					this.refreshConnectionRows();
				})
			);
	}

	// --- Troubleshooting rows ---

	private buildWriteSyncLog(setting: Setting): void {
		setting
			.setName("Write sync log")
			.setDesc(
				`Save a detailed log of each sync (including any errors) to "${this.plugin.settings.subfolder}/${SYNC_LOG_FILENAME}". Useful for diagnosing sync failures.`
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.writeSyncLog)
					.onChange(async (value) => {
						this.plugin.settings.writeSyncLog = value;
						await this.plugin.saveSettings();
					})
			);
	}

	private buildOpenSyncLog(setting: Setting): void {
		setting
			.setName("Open sync log")
			.setDesc("Open the most recent sync log to review details and errors.")
			.addButton((btn) =>
				btn.setButtonText("Open log").onClick(async () => {
					await this.plugin.openSyncLog();
				})
			);
	}

	// --- Support ---

	private buildDonate(parentEl: HTMLElement): void {
		const donateEl = parentEl.createDiv({ cls: "remarkable-sync-donate" });
		const donateLink = donateEl.createEl("a", {
			href: "https://buymeacoffee.com/keystone.studios",
		});
		donateLink.setAttr("target", "_blank");
		donateLink.createEl("img", {
			cls: "remarkable-sync-donate-img",
			attr: {
				src: "https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png",
				alt: "Buy Me A Coffee",
			},
		});
	}
}
