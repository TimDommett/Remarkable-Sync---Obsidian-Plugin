/**
 * Unit tests for the Markdown exporter.
 *
 * Run: npx tsx --test src/markdown-converter.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { textBlockToMarkdown, textBlocksToMarkdown, PAGE_SEPARATOR } from "./markdown-converter";
import {
	parseRmFile,
	type TextBlock,
	STYLE_PLAIN,
	STYLE_HEADING,
	STYLE_BOLD,
	STYLE_BULLET,
	STYLE_BULLET2,
	STYLE_CHECKBOX,
	STYLE_CHECKBOX_CHECKED,
	STYLE_NUMBERED,
} from "./rm-parser";

/** Build a text block from [style, paragraph] pairs, keying styles by start offset like rm-parser. */
function block(paragraphs: [number, string][]): TextBlock {
	const paragraphStyles = new Map<number, number>();
	let offset = 0;
	for (const [style, text] of paragraphs) {
		paragraphStyles.set(offset, style);
		offset += text.length + 1;
	}
	return {
		text: paragraphs.map(([, text]) => text).join("\n"),
		posX: 0,
		posY: 0,
		width: 1000,
		paragraphStyles,
	};
}

test("maps every paragraph style to its Markdown equivalent", () => {
	const md = textBlockToMarkdown(
		block([
			[STYLE_HEADING, "Title"],
			[STYLE_BOLD, "Subheading"],
			[STYLE_PLAIN, "Body"],
			[STYLE_BULLET, "Bullet"],
			[STYLE_BULLET2, "Nested bullet"],
			[STYLE_CHECKBOX, "Todo"],
			[STYLE_CHECKBOX_CHECKED, "Done"],
			[STYLE_NUMBERED, "First"],
		])
	);
	assert.equal(
		md,
		[
			"# Title",
			"## Subheading",
			"Body",
			"- Bullet",
			"  - Nested bullet",
			"- [ ] Todo",
			"- [x] Done",
			"1. First",
		].join("\n")
	);
});

test("numbering continues across blank lines and restarts after another paragraph", () => {
	const md = textBlockToMarkdown(
		block([
			[STYLE_NUMBERED, "a"],
			[STYLE_NUMBERED, ""],
			[STYLE_NUMBERED, "b"],
			[STYLE_HEADING, "Next"],
			[STYLE_NUMBERED, "c"],
		])
	);
	assert.equal(md, "1. a\n\n2. b\n\n# Next\n1. c");
});

test("separates a list from a following paragraph so it is not folded into the last item", () => {
	const md = textBlockToMarkdown(
		block([
			[STYLE_BULLET, "item"],
			[STYLE_PLAIN, "after list"],
			[STYLE_CHECKBOX, "todo"],
			[STYLE_HEADING, "Heading"],
		])
	);
	assert.equal(md, "- item\n\nafter list\n- [ ] todo\n\n# Heading");
});

test("a nested bullet with no parent item is not indented (would be a code block)", () => {
	const md = textBlockToMarkdown(
		block([
			[STYLE_HEADING, "Heading"],
			[STYLE_BULLET2, "orphan"],
			[STYLE_BULLET2, "nested"],
		])
	);
	assert.equal(md, "# Heading\n- orphan\n  - nested");
});

test("nested bullets align under numbered items and don't break the numbering", () => {
	const items: [number, string][] = [];
	for (let i = 1; i <= 100; i++) items.push([STYLE_NUMBERED, `n${i}`]);
	items.push([STYLE_BULLET2, "nested"]);
	items.push([STYLE_NUMBERED, "n101"]);
	const lines = textBlockToMarkdown(block(items)).split("\n");
	assert.deepEqual(lines.slice(-3), ["100. n100", "     - nested", "101. n101"]);
});

test("paragraphs without a style entry are plain text", () => {
	const tb: TextBlock = {
		text: "one\ntwo",
		posX: 0,
		posY: 0,
		width: 1000,
		paragraphStyles: new Map([[0, STYLE_HEADING]]),
	};
	assert.equal(textBlockToMarkdown(tb), "# one\ntwo");
});

test("trims paragraphs (so indentation never becomes a code block) and collapses blank lines", () => {
	const md = textBlockToMarkdown(
		block([
			[STYLE_PLAIN, ""],
			[STYLE_PLAIN, "  indented  "],
			[STYLE_PLAIN, ""],
			[STYLE_PLAIN, ""],
			[STYLE_PLAIN, ""],
			[STYLE_PLAIN, "after"],
			[STYLE_PLAIN, ""],
		])
	);
	assert.equal(md, "indented\n\nafter");
});

test("textBlocksToMarkdown separates pages and returns null when there is no text", () => {
	assert.equal(textBlocksToMarkdown([]), null);
	assert.equal(textBlocksToMarkdown([block([[STYLE_PLAIN, "   "]])]), null);
	assert.equal(
		textBlocksToMarkdown([
			block([[STYLE_PLAIN, "page one"]]),
			block([[STYLE_PLAIN, ""]]),
			block([[STYLE_PLAIN, "page two"]]),
		]),
		"page one" + PAGE_SEPARATOR + "page two\n"
	);
});

test("converts the Text reference sheet (real .rm v6 data)", () => {
	const dir = join(__dirname, "..", "reference_sheets", "Text");
	const rmFile = readdirSync(dir).find((f) => f.endsWith(".rm"));
	assert.ok(rmFile, "Text reference sheet .rm file should exist");
	const data = readFileSync(join(dir, rmFile));
	const page = parseRmFile(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));

	assert.equal(
		textBlocksToMarkdown(page.textBlocks),
		[
			"# Title",
			"## Sub Title",
			"Text",
			"- Bulletpoints",
			"- [ ] Checkbox",
			"1. Numbered point",
			"",
			"Bold",
			"Italic",
		].join("\n") + "\n"
	);
});
