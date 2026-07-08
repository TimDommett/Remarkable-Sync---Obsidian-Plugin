import tsparser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";

// Lint the plugin source against the SAME ruleset the Obsidian community review
// platform runs: `eslint-plugin-obsidianmd`'s `recommended` preset, which layers
// in typescript-eslint's type-checked rules (no-unsafe-*, no-explicit-any,
// no-floating-promises, no-unsafe-enum-comparison, …) plus `no-unsupported-api`
// (which rejects Obsidian APIs newer than manifest.json `minAppVersion`).
//
// Running the full preset in CI means a store-review regression — an untyped
// `any`, a stray `fetch`, a minAppVersion mismatch — fails `npm run lint` here
// instead of surfacing as a failed marketplace review after release. The type-
// checked rules need the TS program, so the source block enables
// `projectService` and excludes the test files (which pull in node-only helpers
// and would otherwise slow/!break project resolution).
//
// `ui/sentence-case` is intentionally turned OFF: it wants to lowercase the
// "reMarkable" trademark (e.g. "Sync reMarkable" -> "Sync remarkable"), which
// would violate Obsidian's own "preserve trademark capitalization" guideline.
// The marketplace review does not flag it either.
export default [
	{
		ignores: ["node_modules/**", "release/**", "**/*.test.ts"],
	},
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parser: tsparser,
			ecmaVersion: "latest",
			sourceType: "module",
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
