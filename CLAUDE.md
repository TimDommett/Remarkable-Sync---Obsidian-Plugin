# CLAUDE.md

This project keeps a single source of truth for AI development guidance in
[`AGENTS.md`](./AGENTS.md). Please read that file — it covers the architecture,
the `FileOps`/`FetchFn` abstractions, rendering-fidelity rules, build/test
commands, and conventions.

Quick start:

```bash
npm install
npm run build                              # type-check + bundle
npx tsc -noEmit -skipLibCheck              # type-check only
npm run test:unit                          # unit tests (cloud client)
npx tsx --test src/sync-manager.test.ts    # run a specific test file
```

Run the dev build in a real vault (build output is git-ignored):

```bash
npm run build
ln -s "$(pwd)/release/remarkable-sync" "<vault>/.obsidian/plugins/remarkable-sync"
# Windows: mklink /D from an elevated prompt, or copy the folder.
# Enable "reMarkable Sync" under Settings > Community plugins, then reload (Ctrl/Cmd+R).
```

Key reminders (see `AGENTS.md` for the full version):

- **Always verify changes manually in a real Obsidian vault** before considering
  them done. `tsc`, `npm run build`, and unit tests are necessary but NOT
  sufficient for renderer or sync changes — install the dev build (above), reload,
  and exercise the change (run a sync; open the produced PDFs and compare against
  `reference_sheets/`; open the settings tab). If you can't verify in a vault
  yourself, say so and ask the user to.
- Keep core modules (`cloud-client`, `sync-manager`, `document-converter`,
  `rm-parser`, `pdf-renderer`) free of `obsidian` imports; only `main.ts` and
  `settings.ts` may import `obsidian`.
- `pdf-renderer.ts` / `rm-parser.ts` and the coordinate/scale constants are
  calibrated against `reference_sheets/` — validate any rendering change with the
  comparison tools.
- Indentation is tabs. `release/` is git-ignored build output. Don't commit
  tokens/secrets.
