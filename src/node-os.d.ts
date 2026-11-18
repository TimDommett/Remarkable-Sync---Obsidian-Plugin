// The plugin uses exactly one Node API: os.homedir(), to find the token file
// written by versions up to 1.0.9 (see token-migration.ts). Declaring it here
// keeps the source fully typed where @types/node is not installed, such as in
// the community directory's automated review scan.
declare module "os" {
	export function homedir(): string;
}
