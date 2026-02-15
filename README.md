# reMarkable Sync for Obsidian

Sync your reMarkable Paper Pro documents to your Obsidian vault as high-fidelity PDFs.

If you find this plugin useful, please consider [supporting its development](https://timdom.gumroad.com/l/remarkkable-to-obsidian-sync-plugin) or buying me a coffee:

<a href="https://buymeacoffee.com/keystone.studios" target="_blank">
  <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="60">
</a>

## Features

- **Direct Cloud Sync** - connects to reMarkable Cloud API
- **High-fidelity PDF rendering** - all 9 pen types with calibrated colors, widths, and opacity
- **Full color support** - 14 colors including shader and highlighter
- **Text rendering** - paragraph styles (headings, bold, bullets, checkboxes, numbered lists)
- **Layered drawing support** - preserves layer ordering
- **Extended pages** - vertically scrolled pages rendered correctly
- **Incremental sync** - only downloads changed documents
- **Auto-sync** - configurable sync interval
- **Annotated PDFs** - merges your annotations with the original PDF background

### Supported pen types

Ballpoint, Fineliner, Marker, Pencil, Mechanical Pencil, Calligraphy Pen, Paintbrush, Highlighter, Shader

## Installation

1. Download **remarkable-sync.zip** from the [latest release](https://github.com/TimDommett/Remarkable-Sync---Obsidian-Plugin/releases/latest)
2. Extract it — you'll get a `remarkable-sync/` folder
3. Copy that folder into `<vault>/.obsidian/plugins/`
4. Open Obsidian Settings > Community Plugins > Enable "reMarkable Sync"
5. Go to the plugin settings and authenticate with your reMarkable account

**Note:** This is a desktop-only plugin (requires Obsidian desktop app).

## Authentication

1. Go to https://my.remarkable.com/device/desktop/connect to get a one-time code
2. Enter the code in the plugin settings (Obsidian Settings > reMarkable Sync)
3. Auth tokens are stored locally at `~/.remarkable-sync/token.json`

## Usage

- Click the tablet icon in the Obsidian ribbon to sync
- Or use the command palette: **reMarkable Sync: Sync now**
- Documents are saved as PDFs in your configured vault subfolder
- Enable auto-sync in settings for hands-free operation

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| Sync folder | `reMarkable/` | Subfolder in your vault for synced documents |
| Auto-sync | Off | Sync automatically on a timer |
| Sync interval | 5 min | How often to auto-sync |

## Development

### Project structure

```
src/                          # TypeScript source code
  cloud-client.ts             # reMarkable Cloud API (sync15/v3 protocol)
  rm-parser.ts                # v6 binary .rm format parser
  pdf-renderer.ts             # PDF generation via pdf-lib
  document-converter.ts       # ZIP → PDF pipeline (jszip + pdf-lib)
  sync-manager.ts             # Sync orchestration with incremental state tracking
  main.ts                     # Obsidian plugin entry point
  settings.ts                 # Settings tab UI
  constants.ts                # Shared constants

reference_sheets/             # Ground truth: PDFs exported from reMarkable + raw .rm files
compare-reference-sheets.ts   # Metadata comparison tool
compare-pixels.mjs            # Pixel-to-pixel rasterized comparison (MuPDF WASM)
compare-pdfs.ts               # PDF comparison utility
re-render.ts                  # Re-renders .rm files to PDFs for comparison
verify-coords.mjs             # Coordinate mapping verification

run-sync.ts                   # Standalone CLI sync (no Obsidian dependency)
release/remarkable-sync/      # Pre-built plugin files (main.js, manifest.json, styles.css)
```

### Prerequisites

- Node.js 18+
- npm

### Setup

```bash
git clone https://github.com/TimDommett/Remarkable-Sync---Obsidian-Plugin.git
cd Remarkable-Sync---Obsidian-Plugin
npm install
```

### Build

```bash
npm run build    # Production build with type checking
npm run dev      # Watch mode (rebuilds on changes)
```

The build output is `main.js` in the project root.

### Testing outside Obsidian

You can test the sync engine without Obsidian using the standalone CLI:

```bash
npx tsx run-sync.ts    # Sync all documents to ./reMarkable
```

Get a one-time auth code from: https://my.remarkable.com/device/desktop/connect

### Testing in Obsidian

1. Run `npm run build`
2. Copy or symlink `main.js`, `manifest.json`, and `styles.css` to `<vault>/.obsidian/plugins/remarkable-sync/`
3. Reload Obsidian (Ctrl+R) and enable the plugin

### Reference sheets

The `reference_sheets/` directory contains PDFs exported directly from reMarkable alongside their raw `.rm` source files. These are the ground truth for validating rendering accuracy.

Each subdirectory covers a specific pen tool or feature with every color and thickness:
- **Pen tools:** Ballpoint, Calligraphy Pen, Fineliner, Highlighter, Marker, Mechanical Pencil, Paintbrush, Pencil, Shader
- **Features:** Text, Checklist, Layers, Pages
- **Templates:** Blank, Grid medium, Lined

Use the comparison tools to validate rendering:

```bash
npx tsx compare-reference-sheets.ts   # Compare metadata (colors, widths, dimensions)
node compare-pixels.mjs               # Pixel comparison against reference PDFs
npx tsx re-render.ts                   # Re-render .rm files and compare output
```

### Architecture notes

- **`FileOps` interface** abstracts file I/O so the same core code works in both Node.js (CLI) and Obsidian (plugin)
- **reMarkable v6 .rm format** is parsed from binary with zero dependencies — see `rm-parser.ts`
- **Coordinate mapping** converts .rm canvas coordinates (1404x1872, centered X) to PDF points (514pt wide)
- **CRDT text** is decoded with topological sorting for correct character ordering
- Runtime dependencies: `pdf-lib` (PDF creation) and `jszip` (ZIP reading), bundled into the plugin

## Contributing

Contributions are welcome! If you'd like to help improve this plugin:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Run `npm run build` to verify your changes compile
4. Test in Obsidian (see "Testing in Obsidian" above)
5. Commit your changes (`git commit -m "Add my feature"`)
6. Push to your branch (`git push origin feature/my-feature`)
7. Open a Pull Request

### Bug reports

Please open an issue with:
- A description of the problem
- Steps to reproduce
- Your Obsidian version and OS
- Any relevant error messages from the developer console (Ctrl+Shift+I)

## Acknowledgments

The `.rm` file parsing implementation in this plugin is based on / inspired by
[rmscene](https://github.com/ricklupton/rmscene) by Rick Lupton, originally
written in Python. Licensed under the MIT License.

## License

Copyright (c) 2026 Tim Dommett

This project is licensed under the [GNU General Public License v3.0](LICENSE). You are free to use, modify, and distribute this software, but derivative works must also be open source under the same license.

### Third-party licenses

This project bundles the following MIT-licensed libraries:
- [pdf-lib](https://github.com/Hopding/pdf-lib) by Andrew Dillon (and its dependencies)
- [jszip](https://github.com/Stuk/jszip) by Stuart Knightley et al. (and its dependencies: pako, lie, readable-stream)

The `.rm` file parser is derived from:
- [rmscene](https://github.com/ricklupton/rmscene) by Rick Lupton — MIT License

See [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES) for full license texts.
