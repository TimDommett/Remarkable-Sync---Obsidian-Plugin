import obsidianmd from "eslint-plugin-obsidianmd";

// Lint the plugin source with eslint-plugin-obsidianmd's `recommended` preset.
// It is the rule set the community plugin directory's automated review runs
// on each release (Obsidian's guideline rules plus typescript-eslint's
// type-checked rules such as `no-unsafe-*` and `no-floating-promises`), so CI
// catches anything that would lower the plugin's review score before release.
//
// The preset includes `no-unsupported-api`, which needs type information to
// resolve each call against `obsidian.d.ts` `@since` tags. It rejects APIs
// newer than `manifest.json` `minAppVersion`, so a mismatch fails the build
// here instead of surfacing as a failed store review after release.
//
// `ui/sentence-case` is intentionally left off: it wants to lowercase the
// "reMarkable" trademark (e.g. "Sync reMarkable" -> "Sync remarkable"), which
// would violate Obsidian's own "preserve trademark capitalization" guideline.
export default [
	{
		// Tests are not part of the released plugin and are not reviewed.
		ignores: ["node_modules/**", "release/**", "**/*.test.ts"],
	},
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"obsidianmd/ui/sentence-case": "off",
		},
	},
];
