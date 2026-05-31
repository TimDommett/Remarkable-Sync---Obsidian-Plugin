import tsparser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";

// Lint the plugin source against Obsidian's community guideline rules.
//
// We enable the `eslint-plugin-obsidianmd` rules explicitly (rather than the
// plugin's `recommended` preset) so CI does not pull in the heavy
// typescript-eslint type-checked ruleset, which floods this calibrated binary
// parser with `no-unsafe-*` noise that is unrelated to Obsidian review.
//
// `ui/sentence-case` is intentionally left off: it wants to lowercase the
// "reMarkable" trademark (e.g. "Sync reMarkable" -> "Sync remarkable"), which
// would violate Obsidian's own "preserve trademark capitalization" guideline.
export default [
	{
		ignores: ["node_modules/**", "release/**", "**/*.test.ts"],
	},
	{
		files: ["src/**/*.ts"],
		plugins: { obsidianmd },
		languageOptions: {
			parser: tsparser,
			ecmaVersion: "latest",
			sourceType: "module",
		},
		rules: {
			"obsidianmd/settings-tab/no-manual-html-headings": "error",
			"obsidianmd/settings-tab/no-problematic-settings-headings": "error",
			"obsidianmd/no-static-styles-assignment": "error",
			"obsidianmd/no-forbidden-elements": "error",
			"obsidianmd/no-global-this": "error",
			"obsidianmd/prefer-active-doc": "error",
			"obsidianmd/prefer-window-timers": "error",
			"obsidianmd/hardcoded-config-path": "error",
			"obsidianmd/commands/no-command-in-command-id": "error",
			"obsidianmd/commands/no-command-in-command-name": "error",
			"obsidianmd/commands/no-plugin-id-in-command-id": "error",
			"obsidianmd/commands/no-plugin-name-in-command-name": "error",
			"obsidianmd/commands/no-default-hotkeys": "error",
			"obsidianmd/sample-names": "error",
			"obsidianmd/no-sample-code": "error",
		},
	},
];
