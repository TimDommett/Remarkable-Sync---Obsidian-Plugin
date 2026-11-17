# Contributing to reMarkable Sync

Thanks for helping improve the plugin. This guide covers setup, the checks to run
before opening a pull request, and the rules of Obsidian's automated plugin review,
which every release of this plugin goes through.

This repository is public. Never commit tokens, secrets, or anything from your own
`~/.remarkable-sync/` folder, and don't paste them into issues or pull requests.

## Getting started

```bash
npm install
npm run build        # type-check + bundle into release/remarkable-sync/
npm run dev          # rebuild on change
```

To try a build in Obsidian, link the build output into a test vault and reload:

```bash
ln -s "$(pwd)/release/remarkable-sync" "<vault>/.obsidian/plugins/remarkable-sync"
```

[AGENTS.md](AGENTS.md) describes the architecture in more depth: the `FileOps` and
`FetchFn` abstractions, which modules may import `obsidian`, and the calibrated
renderer.

## Before you open a pull request

Run every check CI runs:

```bash
npm run lint                                 # Obsidian's lint preset
npm run typecheck
npm run build
npm run test:unit
npm ci --prefix scripts/community-scan       # once: install the review scan
npm run scan:community                       # replica of Obsidian's automated review
```

Then check the change in a real vault: run a sync, open the generated PDFs, and open
the settings tab. Rendering changes (`pdf-renderer.ts`, `rm-parser.ts`, coordinate or
scale constants) must also be compared against `reference_sheets/` with
`npx tsx re-render.ts`, `npx tsx compare-reference-sheets.ts` and
`node compare-pixels.mjs`.

CI runs on pushes to this repository, not on pull requests from forks, so please run
the checks yourself and mention the results in your pull request.

## Obsidian's automated plugin review

Obsidian's [community plugin directory](https://community.obsidian.md/plugins/remarkable-sync)
scans every release and publishes a scorecard. Its **Review** rating comes from these
automated checks, described in
[The future of plugins](https://obsidian.md/blog/future-of-plugins/). Most of them
are the `recommended` rules of Obsidian's open-source ESLint plugin,
[eslint-plugin-obsidianmd](https://github.com/obsidianmd/eslint-plugin)
([npm](https://www.npmjs.com/package/eslint-plugin-obsidianmd)), which include
typescript-eslint's
[type-checked rules](https://typescript-eslint.io/users/configs/#recommended-type-checked).
The rest follow Obsidian's [developer policies](https://docs.obsidian.md/Developer+policies)
and [plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines).
Keep the plugin source free of findings.

### Type safety

- Don't use `any`. Give parsed JSON an interface and an `as` assertion (see
  `TokenStore.load` in `cloud-client.ts`), or use `unknown` and narrow it.
- Don't read properties of, call, return, or pass on values typed `any`. Typing the
  value at its source fixes all of these at once.
- Don't add type assertions that don't change the type.
- Remove unused variables. In the binary parser, a read that only advances the
  cursor stays as a bare call such as `reader.readU8();`.
- Compare enums with values of the same enum type: type a field like
  `Stroke.penType` as `PenType`, not `number`.

### Promises

- Await every promise. Mark intentional fire-and-forget calls with `void`, as in
  `void this.runSync();`.

### Obsidian APIs

- Use `requestUrl` for network requests, never `fetch`.
- Read and write vault files through the vault adapter (see `getVaultFileOps` in
  `main.ts`).
- Keep per-vault data that must not live in the vault's files, such as auth tokens,
  in `app.saveLocalStorage()` / `app.loadLocalStorage()`. Don't use the global
  `localStorage`, and never put secrets in `data.json` or anywhere else in the vault.
- Don't use APIs newer than `minAppVersion` in `manifest.json`. The lint rule
  `obsidianmd/no-unsupported-api` checks this. If you raise `minAppVersion`, add the
  new version to `versions.json`, so people on older Obsidian versions keep getting
  the last release that supports them.
- The settings tab supports both Obsidian 1.13+ (`getSettingDefinitions()`, which
  also makes settings searchable) and older versions (`display()`). Both build each
  row with the same builder methods in `settings.ts`. Add new settings through a
  builder and list them in both places. See Obsidian's guide to
  [declarative settings](https://docs.obsidian.md/plugins/guides/migrate-declarative-settings).

### Behavior checks

The directory also reports what a plugin does on the user's machine. These checks
run on Obsidian's side; `npm run scan:community` approximates them.

- Don't import Node's `fs` module. The review reports it as "Direct Filesystem
  Access". Vault files go through the vault adapter.
- Don't read environment variables or call `os.hostname()`, `os.userInfo()` or
  `os.networkInterfaces()`. The review reports these as reading "system identity
  information". The plugin's only Node API is `os.homedir()`, used once to migrate
  the auth token from versions up to 1.0.9 (`token-migration.ts`).

### Regular expressions

- Don't put control characters (code points below U+0020) in a regular expression,
  including as escapes. Write the intended ranges explicitly instead (see
  `sanitizeForWinAnsi` in `pdf-renderer.ts`).

### Releases

- Releases are built by GitHub Actions from the tagged commit, with build-provenance
  attestations, and the directory checks that the build reproduces the released
  `main.js` byte for byte. Don't commit build output, and don't change the build
  configuration without reason.
- A version bump touches `manifest.json`, `package.json`, `package-lock.json` (use
  `npm version x.y.z --no-git-tag-version`) and `versions.json`. The release tag
  must equal the manifest version, with no `v` prefix.

## Running the review scan locally

`npm run scan:community` runs `scripts/community-scan`, which reproduces how the
directory scans a release:

- the `recommended` preset of a pinned `eslint-plugin-obsidianmd` release, with the
  latest Obsidian typings;
- type-checking without `@types/node`, which is why every Node API the source uses
  needs its own typing (see `src/node-os.d.ts`);
- test files excluded;
- the behavior checks above, as extra rules.

It fails on any finding, warnings included. It reproduces the published scorecards
for 1.0.8 and 1.0.9 rule for rule. The directory's own scan stays authoritative,
especially for the behavior checks: maintainers can run a preview scan on any branch
from the [developer dashboard](https://community.obsidian.md/) before a release.

When Obsidian publishes new versions of the ESLint plugin or typings, update the
pinned versions in `scripts/community-scan/package.json`, run
`npm install --prefix scripts/community-scan`, and commit the updated lockfile.

## Code style

- Indent with tabs.
- Keep `cloud-client.ts`, `sync-manager.ts`, `document-converter.ts`,
  `rm-parser.ts`, `pdf-renderer.ts` and `token-migration.ts` free of `obsidian`
  imports. Only `main.ts` and `settings.ts` import it.
- Write comments that explain intent or trade-offs, not ones that narrate the code.
- Add unit tests as `src/<module>.test.ts` (Node's test runner, run via `tsx`).

## Reporting bugs

Open an issue with the steps to reproduce, your Obsidian version and OS, and the
relevant part of `<sync folder>/_reMarkable Sync Log.md` (Settings > reMarkable Sync >
Open log). For security problems, please don't post details publicly: open an issue
asking for a private contact instead.
