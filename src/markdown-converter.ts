/**
 * Markdown Converter
 *
 * Exports the typed text of a reMarkable page as Markdown. Only typed text
 * (keyboard / Type Folio / "Convert to text") is exported; handwriting and
 * drawings are ignored, so a handwriting-only document produces no Markdown.
 *
 * Paragraph styles map to their Markdown equivalents. Text is otherwise
 * emitted verbatim (not escaped), so Markdown typed on the tablet — e.g.
 * "# Heading" — renders as Markdown in Obsidian. The flip side is that typed
 * syntax is interpreted too (a "---" line under text makes it a heading).
 */

import {
	STYLE_PLAIN,
	STYLE_HEADING,
	STYLE_BOLD,
	STYLE_BULLET,
	STYLE_BULLET2,
	STYLE_CHECKBOX,
	STYLE_CHECKBOX_CHECKED,
	STYLE_NUMBERED,
	type TextBlock,
} from "./rm-parser";

/** Separator placed between pages that contain typed text. */
export const PAGE_SEPARATOR = "\n\n---\n\n";

const LIST_STYLES = new Set([
	STYLE_BULLET,
	STYLE_BULLET2,
	STYLE_CHECKBOX,
	STYLE_CHECKBOX_CHECKED,
	STYLE_NUMBERED,
]);

/**
 * Convert one text block to Markdown. Paragraph styles are keyed by the
 * character offset at which each paragraph starts (see rm-parser).
 */
export function textBlockToMarkdown(tb: TextBlock): string {
	const lines: string[] = [];
	let offset = 0;
	let inList = false;
	let listNumber = 0;
	// Width of the last top-level list marker; a nested bullet must be
	// indented at least this far to belong to that item ("100. " needs 5).
	let nestIndent = 2;

	for (const paragraph of tb.text.split("\n")) {
		const style = tb.paragraphStyles.get(offset) ?? STYLE_PLAIN;
		offset += paragraph.length + 1;

		// Trimmed for every style: leading spaces would otherwise turn a
		// paragraph into a Markdown code block.
		const body = paragraph.trim();
		if (!body) {
			lines.push("");
			continue;
		}

		const isListItem = LIST_STYLES.has(style);
		// Without a blank line, CommonMark folds a paragraph that follows a
		// list item into that item ("lazy continuation").
		if (inList && !isListItem && lines[lines.length - 1] !== "") {
			lines.push("");
		}
		// Numbering continues across blank lines and nested bullets, and
		// restarts after any other kind of paragraph.
		if (style !== STYLE_NUMBERED && style !== STYLE_BULLET2) listNumber = 0;

		switch (style) {
			case STYLE_HEADING:
				lines.push(`# ${body}`);
				break;
			case STYLE_BOLD:
				// The tablet presents this style as a subheading.
				lines.push(`## ${body}`);
				break;
			case STYLE_BULLET:
				lines.push(`- ${body}`);
				nestIndent = 2;
				break;
			case STYLE_BULLET2:
				// Indented only under a list item: an indented line with no
				// parent item is a code block, not a nested bullet.
				if (inList) {
					lines.push(`${" ".repeat(nestIndent)}- ${body}`);
				} else {
					lines.push(`- ${body}`);
					nestIndent = 2;
				}
				break;
			case STYLE_CHECKBOX:
				lines.push(`- [ ] ${body}`);
				nestIndent = 2;
				break;
			case STYLE_CHECKBOX_CHECKED:
				lines.push(`- [x] ${body}`);
				nestIndent = 2;
				break;
			case STYLE_NUMBERED: {
				const marker = `${++listNumber}. `;
				lines.push(marker + body);
				nestIndent = marker.length;
				break;
			}
			default:
				lines.push(body);
		}
		inList = isListItem;
	}

	// Collapse runs of blank lines and drop leading/trailing ones.
	return lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
}

/**
 * Join the text blocks of a document's pages into a single Markdown string.
 * Returns null when no page contains typed text.
 */
export function textBlocksToMarkdown(blocks: TextBlock[]): string | null {
	const chunks = blocks.map(textBlockToMarkdown).filter((md) => md.length > 0);
	if (chunks.length === 0) return null;
	return chunks.join(PAGE_SEPARATOR) + "\n";
}
