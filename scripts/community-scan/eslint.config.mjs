// Replica of the Obsidian community plugin directory's automated review scan.
//
// The directory reviews every release with eslint-plugin-obsidianmd's
// `recommended` preset (Obsidian's guideline rules plus typescript-eslint's
// type-checked rules), against the latest Obsidian typings, without
// @types/node, and without the test files. scan.mjs reproduces that setup;
// this config adds approximations of the directory's server-side "Behavior"
// checks, which are not part of the ESLint plugin.
//
// Calibrated against the published scorecards for 1.0.8 and 1.0.9, which it
// reproduces rule for rule. The directory's own scan stays authoritative: use
// the developer dashboard's preview scan before a release.
import obsidianmd from "eslint-plugin-obsidianmd";

const behaviorMessage = (what) =>
	`${what} is reported by the community directory's review as a Behavior warning. See CONTRIBUTING.md.`;

export default [
	{ ignores: ["node_modules/**", "**/*.test.ts"] },
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: process.env.SCAN_ROOT,
			},
		},
		rules: {
			// "Direct Filesystem Access: Uses the Node.js fs module".
			"no-restricted-imports": [
				"error",
				...["fs", "fs/promises", "node:fs", "node:fs/promises", "original-fs"].map((name) => ({
					name,
					message: behaviorMessage("Node's fs module (direct filesystem access)"),
				})),
			],
			// "Plugin reads system identity information".
			"no-restricted-properties": [
				"error",
				...["hostname", "userInfo", "networkInterfaces"].map((property) => ({
					object: "os",
					property,
					message: behaviorMessage(`os.${property}() (system identity information)`),
				})),
			],
			"no-restricted-syntax": [
				"error",
				{
					selector: "MemberExpression[object.name='process'][property.name='env']",
					message: behaviorMessage("Reading environment variables (system identity information)"),
				},
				{
					selector: "ImportSpecifier[imported.name=/^(hostname|userInfo|networkInterfaces)$/]",
					message: behaviorMessage("Importing os identity functions (system identity information)"),
				},
			],
		},
	},
];
