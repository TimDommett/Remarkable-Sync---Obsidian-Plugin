/**
 * Tests for content-driven page-height extension.
 *
 * Regression tests for the bug where long / vertically-scrolled pages were
 * clipped. Two distinct causes:
 *   1. Extension used to be gated behind the optional `verticalScroll`
 *      metadata, so a long page that lacked it kept the default height.
 *   2. Extension only measured STROKE bounds and ignored typed text, so a page
 *      whose typed text extended below the strokes (common on mixed
 *      drawing + text pages) had that text cut off at the bottom.
 * Extension must be content-driven over BOTH strokes and typed text, matching
 * the reference renderer.
 *
 * Run: npx tsx --test src/document-converter.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { extendPageHeightForContent } from "./document-converter";
import { computeTextBlocksBottomRawY } from "./pdf-renderer";
import type { Page, Stroke, TextBlock } from "./rm-parser";

const DEFAULT_HEIGHT = 1872;
// A page is extended only when maxY * 0.885 exceeds DEFAULT_HEIGHT * 1.05.
const THRESHOLD_MAX_Y = (DEFAULT_HEIGHT * 1.05) / 0.885; // ≈ 2221

function strokeReachingY(maxY: number): Stroke {
	return {
		penType: 0,
		color: 0,
		colorArgb: null,
		thicknessScale: 1,
		points: [
			{ x: 0, y: 0, speed: 0, direction: 0, width: 1, pressure: 1 },
			{ x: 0, y: maxY, speed: 0, direction: 0, width: 1, pressure: 1 },
		],
	};
}

// A text block of `lines` single-word lines (no wrapping, so the rendered line
// count is deterministic regardless of glyph widths) anchored at `posY`.
function textBlockAt(posY: number, lines: number, text?: string): TextBlock {
	return {
		text: text ?? Array.from({ length: lines }, () => "x").join("\n"),
		posX: -576,
		posY,
		width: 1152,
		paragraphStyles: new Map<number, number>(),
	};
}

function makePage(opts: { strokeMaxY?: number; textBlocks?: TextBlock[] }): Page {
	return {
		pageId: "page",
		layers: opts.strokeMaxY
			? [{ name: "", strokes: [strokeReachingY(opts.strokeMaxY)] }]
			: [],
		textSpans: [],
		textBlocks: opts.textBlocks ?? [],
		width: 1404,
		height: DEFAULT_HEIGHT,
	};
}

// --- Stroke-driven extension (existing behaviour, now async) ---

test("normal-height content leaves the page height unchanged", async () => {
	const page = makePage({ strokeMaxY: 1500 });
	await extendPageHeightForContent(page);
	assert.equal(page.height, DEFAULT_HEIGHT);
});

test("long page (no verticalScroll metadata) is extended so content isn't clipped", async () => {
	const maxY = 3000;
	assert.ok(maxY > THRESHOLD_MAX_Y, "test fixture must exceed the extension threshold");
	const page = makePage({ strokeMaxY: maxY });
	await extendPageHeightForContent(page);
	assert.equal(page.height, maxY * 0.885);
	assert.ok(page.height > DEFAULT_HEIGHT, "long page must be taller than the default");
});

test("content just past the screen but under the threshold is not extended", async () => {
	// 2000 * 0.885 = 1770, which is below DEFAULT_HEIGHT * 1.05 (= 1965.6).
	const page = makePage({ strokeMaxY: 2000 });
	assert.ok(2000 < THRESHOLD_MAX_Y);
	await extendPageHeightForContent(page);
	assert.equal(page.height, DEFAULT_HEIGHT);
});

test("a page with no strokes or text keeps the default height", async () => {
	const page = makePage({});
	await extendPageHeightForContent(page);
	assert.equal(page.height, DEFAULT_HEIGHT);
});

// --- Typed-text-driven extension (the new fix) ---

test("typed text below the strokes extends the page so it isn't clipped", async () => {
	// Strokes end well within a normal page; a long text block sits below them.
	const tb = textBlockAt(1800, 12);
	const page = makePage({ strokeMaxY: 1500, textBlocks: [tb] });

	const textBottom = await computeTextBlocksBottomRawY(page);
	assert.ok(
		textBottom > THRESHOLD_MAX_Y,
		"fixture: text must extend past the threshold the strokes don't reach"
	);
	assert.ok(textBottom > 1500, "fixture: text must extend below the strokes");

	await extendPageHeightForContent(page);
	// Height is driven by the (lower) text bottom, not the strokes.
	assert.ok(Math.abs(page.height - textBottom * 0.885) < 1e-6);
	assert.ok(page.height > DEFAULT_HEIGHT, "mixed text+drawing page must grow to fit the text");
});

test("text extent is honoured even when strokes already trigger extension", async () => {
	// Strokes already exceed the threshold, but the text reaches even lower —
	// the page must grow to the text, proving text isn't dropped once strokes
	// alone would extend the page.
	const tb = textBlockAt(2600, 4);
	const page = makePage({ strokeMaxY: 2300, textBlocks: [tb] });

	const textBottom = await computeTextBlocksBottomRawY(page);
	assert.ok(textBottom > 2300, "fixture: text must reach below the strokes");

	await extendPageHeightForContent(page);
	assert.ok(Math.abs(page.height - textBottom * 0.885) < 1e-6);
});

test("short typed text near the top neither shrinks nor extends a normal page", async () => {
	const tb = textBlockAt(234, 3); // a few lines near the default text anchor
	const page = makePage({ textBlocks: [tb] });

	const textBottom = await computeTextBlocksBottomRawY(page);
	assert.ok(textBottom < THRESHOLD_MAX_Y, "fixture: short text must stay under the threshold");

	await extendPageHeightForContent(page);
	assert.equal(page.height, DEFAULT_HEIGHT);
});

test("empty / whitespace-only text blocks are ignored", async () => {
	// Anchored very low, but with no real content — must contribute nothing,
	// mirroring renderTextBlock's `if (!tb.text.trim()) return`.
	const tb = textBlockAt(3000, 0, "   \n  ");
	const page = makePage({ textBlocks: [tb] });

	assert.equal(await computeTextBlocksBottomRawY(page), 0);

	await extendPageHeightForContent(page);
	assert.equal(page.height, DEFAULT_HEIGHT);
});
