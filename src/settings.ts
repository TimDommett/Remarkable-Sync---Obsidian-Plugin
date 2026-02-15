import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type RemarkableSyncPlugin from "./main";
import { SYNC_INTERVALS, AUTH_URL, DEFAULT_SUBFOLDER } from "./constants";

export interface RemarkableSyncSettings {
	subfolder: string;
	syncIntervalLabel: string;
	folderFilter: string;
	lastSyncTime: string;
	isAuthenticated: boolean;
}

export const DEFAULT_SETTINGS: RemarkableSyncSettings = {
	subfolder: DEFAULT_SUBFOLDER,
	syncIntervalLabel: "Manual only",
	folderFilter: "",
	lastSyncTime: "",
	isAuthenticated: false,
};

export class RemarkableSyncSettingTab extends PluginSettingTab {
	plugin: RemarkableSyncPlugin;

	constructor(app: App, plugin: RemarkableSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// --- Authentication ---
		containerEl.createEl("h2", { text: "Authentication" });

		const isAuth = this.plugin.settings.isAuthenticated;

		new Setting(containerEl)
			.setName((() => {
				const frag = document.createDocumentFragment();
				const dot = frag.createSpan();
				dot.style.display = "inline-block";
				dot.style.width = "8px";
				dot.style.height = "8px";
				dot.style.borderRadius = "50%";
				dot.style.marginRight = "8px";
				dot.style.backgroundColor = isAuth ? "#2ea043" : "#888";
				frag.appendText(isAuth ? "Connected" : "Not connected");
				return frag;
			})())
			.setDesc(isAuth
				? "Authenticated with reMarkable cloud."
				: "Enter a one-time code below to register."
			);

		// Auth code input + register button
		let authCodeValue = "";
		const authSetting = new Setting(containerEl)
			.setName("One-time code")
			.setDesc("Get a code from my.remarkable.com, paste it here, and click Register.")
			.addText((text) =>
				text.setPlaceholder("abcde-fghij").onChange((value) => {
					authCodeValue = value;
				})
			)
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
								new Notice("Authentication successful!");
								this.display(); // Refresh to show green status
							} else {
								new Notice("Authentication failed. Check your code and try again.");
								btn.setButtonText("Register");
								btn.setDisabled(false);
							}
						} catch (err) {
							new Notice("Authentication error: " + (err as Error).message);
							btn.setButtonText("Register");
							btn.setDisabled(false);
						}
					})
			);

		// If already authenticated, dim the auth input
		if (isAuth) {
			authSetting.setDesc("Already connected. Only use this to re-register with a new code.");
		}

		const linkEl = containerEl.createEl("p");
		linkEl.createEl("a", {
			text: "Get your one-time code here",
			href: AUTH_URL,
		});

		// --- Sync Configuration ---
		containerEl.createEl("h2", { text: "Sync Configuration" });

		new Setting(containerEl)
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

		new Setting(containerEl)
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

		new Setting(containerEl)
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

		// --- Status ---
		containerEl.createEl("h2", { text: "Status" });

		new Setting(containerEl)
			.setName("Last sync")
			.setDesc(
				this.plugin.settings.lastSyncTime
					? new Date(this.plugin.settings.lastSyncTime).toLocaleString()
					: "Never"
			);

		new Setting(containerEl)
			.setName("Check status")
			.setDesc("Check current authentication status.")
			.addButton((btn) =>
				btn.setButtonText("Check").onClick(async () => {
					await this.plugin.refreshAuthStatus();
					this.display();
				})
			);

		// --- Support ---
		containerEl.createEl("h2", { text: "Support" });

		const donateEl = containerEl.createDiv({ cls: "remarkable-sync-donate" });
		const donateLink = donateEl.createEl("a", {
			href: "https://buymeacoffee.com/keystone.studios",
		});
		donateLink.setAttr("target", "_blank");
		const donateImg = donateLink.createEl("img", {
			attr: {
				src: "https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png",
				alt: "Buy Me A Coffee",
			},
		});
		donateImg.style.height = "60px";
	}
}
