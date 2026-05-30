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

Key reminders (see `AGENTS.md` for the full version):

- Keep core modules (`cloud-client`, `sync-manager`, `document-converter`,
  `rm-parser`, `pdf-renderer`) free of `obsidian` imports; only `main.ts` and
  `settings.ts` may import `obsidian`.
- `pdf-renderer.ts` / `rm-parser.ts` and the coordinate/scale constants are
  calibrated against `reference_sheets/` — validate any rendering change with the
  comparison tools.
- Indentation is tabs. Don't commit tokens/secrets or `release/` artifact churn
  in source-only PRs.
