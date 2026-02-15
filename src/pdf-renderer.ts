/**
 * PDF Renderer for reMarkable Documents
 *
 * Converts parsed Page objects (with strokes and text) into PDF files
 * using pdf-lib. Handles pen types, colors, pressure sensitivity, and text.
 */

import {
	PDFDocument,
	PDFPage,
	rgb,
	StandardFonts,
	PDFFont,
	LineCapStyle,
	LineJoinStyle,
	setLineJoin,
} from "pdf-lib";

import type { Page, Stroke, Point, TextBlock } from "./rm-parser";
import { PenType } from "./rm-parser";

// --- Constants ---

export const RM_DEFAULT_WIDTH_PX = 1404;
export const RM_DEFAULT_HEIGHT_PX = 1872;

// reMarkable Paper Pro screen dimensions (pixels)
export const RM_SCREEN_WIDTH_PX = 1620;
export const RM_SCREEN_HEIGHT_PX = 2160;

// Scale factor for stroke widths: maps .rm raw widths to PDF points.
// Calibrated: 1404px → 514pt.
export const SCALE = 514 / RM_DEFAULT_WIDTH_PX;

// Coordinate scale for position mapping: maps screen pixels to PDF points.
// The .rm coordinates sit 1:1 in screen pixel space (centered horizontally at x=810).
// Reference PDF CTM confirms: 514/1620 = 0.317180616.
export const COORD_SCALE = 514 / RM_SCREEN_WIDTH_PX;

// Color map: index → {r, g, b} in 0–1 range
// Values calibrated against reMarkable's own PDF export (reference_sheets/)
const COLOR_MAP: Record<number, { r: number; g: number; b: number }> = {
	0: { r: 0, g: 0, b: 0 },                          // BLACK
	1: { r: 0.5647, g: 0.5647, b: 0.5647 },            // GRAY
	2: { r: 1, g: 1, b: 1 },                           // WHITE
	3: { r: 0.9804, g: 0.9059, b: 0.0980 },            // YELLOW
	4: { r: 0.5686, g: 0.8549, b: 0.4431 },            // GREEN
	5: { r: 0.7529, g: 0.4980, b: 0.8235 },            // MAGENTA (labeled "Pink" in UI)
	6: { r: 0.1882, g: 0.2902, b: 0.8784 },            // BLUE
	7: { r: 0.7608, g: 0.1922, b: 0.1961 },            // RED
	8: { r: 0.5647, g: 0.5647, b: 0.5647 },            // GRAY_OVERLAP
	9: { r: 0.9804, g: 0.9059, b: 0.0980 },            // HIGHLIGHT (Yellow — used by highlighter pen)
	10: { r: 0.5686, g: 0.8549, b: 0.4431 },           // GREEN_2
	11: { r: 0.4549, g: 0.8235, b: 0.9098 },           // CYAN
	12: { r: 0.7529, g: 0.4980, b: 0.8235 },           // MAGENTA
	13: { r: 0.9804, g: 0.9059, b: 0.0980 },           // YELLOW_2
};

interface PenStyle {
	opacity: number;
	isHighlighter: boolean;
}

const PEN_STYLES: Record<number, PenStyle> = {
	[PenType.BALLPOINT_1]: { opacity: 1.0, isHighlighter: false },
	[PenType.BALLPOINT_2]: { opacity: 1.0, isHighlighter: false },
	[PenType.MARKER_1]: { opacity: 1.0, isHighlighter: false },
	[PenType.MARKER_2]: { opacity: 1.0, isHighlighter: false },
	[PenType.FINELINER_1]: { opacity: 1.0, isHighlighter: false },
	[PenType.FINELINER_2]: { opacity: 1.0, isHighlighter: false },
	[PenType.PENCIL_1]: { opacity: 0.35, isHighlighter: false },
	[PenType.PENCIL_2]: { opacity: 0.35, isHighlighter: false },
	[PenType.MECHANICAL_PENCIL_1]: { opacity: 0.7, isHighlighter: false },
	[PenType.MECHANICAL_PENCIL_2]: { opacity: 0.7, isHighlighter: false },
	[PenType.BRUSH]: { opacity: 1.0, isHighlighter: false },
	[PenType.HIGHLIGHTER_1]: { opacity: 0.45, isHighlighter: true },
	[PenType.HIGHLIGHTER_2]: { opacity: 0.45, isHighlighter: true },
	[PenType.PAINTBRUSH_2]: { opacity: 1.0, isHighlighter: false },
	[PenType.CALLIGRAPHY]: { opacity: 1.0, isHighlighter: false },
	[PenType.SHADER]: { opacity: 0.3, isHighlighter: true },
};

// Paragraph styles
const STYLE_PLAIN = 1;
const STYLE_HEADING = 2;
const STYLE_BOLD = 3;
const STYLE_BULLET = 4;
const STYLE_BULLET2 = 5;
const STYLE_CHECKBOX = 6;
const STYLE_CHECKBOX_CHECKED = 7;
const STYLE_NUMBERED = 10;

interface FontSetting {
	fontKey: typeof StandardFonts[keyof typeof StandardFonts];
	fontSize: number;
	lineHeight: number;
}

// Font sizes and line heights calibrated to match reMarkable's actual PDF export.
// Validated against ground truth in reference_sheets/.
const STYLE_FONTS: Record<number, FontSetting> = {
	[STYLE_HEADING]: { fontKey: StandardFonts.HelveticaBold, fontSize: 18, lineHeight: 26 },
	[STYLE_BOLD]: { fontKey: StandardFonts.HelveticaBold, fontSize: 13, lineHeight: 23 },
};
const DEFAULT_FONT: FontSetting = { fontKey: StandardFonts.Helvetica, fontSize: 10, lineHeight: 23 };

// --- Helpers ---

function getPenStyle(penType: number): PenStyle {
	return PEN_STYLES[penType] ?? { opacity: 1.0, isHighlighter: false };
}

function getColor(colorIndex: number): { r: number; g: number; b: number } {
	return COLOR_MAP[colorIndex] ?? COLOR_MAP[0];
}

function getArgbColor(argb: number): { r: number; g: number; b: number; a: number } {
	return {
		a: ((argb >>> 24) & 0xFF) / 255,
		r: ((argb >>> 16) & 0xFF) / 255,
		g: ((argb >>> 8) & 0xFF) / 255,
		b: (argb & 0xFF) / 255,
	};
}

// Width factor calibrated against reMarkable's own PDF export.
// Reference uses: widthPt = rawWidth * 0.079 (in content stream coordinate space).
// In our 1:1 PDF point space: widthPt = rawWidth * SCALE * WIDTH_FACTOR.
const WIDTH_FACTOR = 0.216;

function pointWidthPt(point: Point, penType: number): number {
	const base = point.width * SCALE * WIDTH_FACTOR;
	switch (penType) {
		case PenType.BALLPOINT_1:
		case PenType.BALLPOINT_2:
			return Math.max(0.3, Math.min(base, 3.0));
		case PenType.FINELINER_1:
		case PenType.FINELINER_2:
			return Math.max(0.3, Math.min(base, 4.0));
		case PenType.PENCIL_1:
		case PenType.PENCIL_2:
			return Math.max(0.2, Math.min(base, 4.0));
		case PenType.MECHANICAL_PENCIL_1:
		case PenType.MECHANICAL_PENCIL_2:
			return Math.max(0.2, Math.min(base, 3.0));
		case PenType.MARKER_1:
		case PenType.MARKER_2:
			return Math.max(1.0, Math.min(base, 15.0));
		case PenType.CALLIGRAPHY:
			return Math.max(0.2, Math.min(base, 10.0));
		case PenType.PAINTBRUSH_2:
			return Math.max(0.3, Math.min(base, 8.0));
		case PenType.BRUSH:
			return Math.max(0.2, Math.min(base, 10.0));
		default:
			return Math.max(0.2, Math.min(base, 20.0));
	}
}

function getFontSetting(style: number): FontSetting {
	return STYLE_FONTS[style] ?? DEFAULT_FONT;
}

function sanitizeForWinAnsi(text: string): string {
	// Replace Unicode characters that WinAnsi encoding can't handle
	return text
		.replace(/\u2028/g, "\n")  // LINE SEPARATOR → newline
		.replace(/\u2029/g, "\n")  // PARAGRAPH SEPARATOR → newline
		.replace(/[^\x00-\xFF\u2022]/g, ""); // Strip non-WinAnsi chars (keep bullet)
}

function wrapText(text: string, maxWidth: number, font: PDFFont, fontSize: number): string[] {
	const words = text.split(" ");
	const lines: string[] = [];
	let currentLine = "";

	for (const word of words) {
		const test = (currentLine + " " + word).trim();
		const w = font.widthOfTextAtSize(test, fontSize);
		if (w <= maxWidth || !currentLine) {
			currentLine = test;
		} else {
			lines.push(currentLine);
			currentLine = word;
		}
	}
	if (currentLine) lines.push(currentLine);
	return lines.length > 0 ? lines : [""];
}

function getStylePrefix(style: number, _paraIndex: number): string {
	switch (style) {
		case STYLE_BULLET: return "  \u2022 ";
		case STYLE_BULLET2: return "      \u2022 ";
		case STYLE_CHECKBOX: return "[ ] ";
		case STYLE_CHECKBOX_CHECKED: return "[x] ";
		case STYLE_NUMBERED: return "1. ";
		default: return "";
	}
}

function isBoldStyle(style: number): boolean {
	return style === STYLE_HEADING || style === STYLE_BOLD;
}

function computeTextBlockHeightPt(
	tb: TextBlock,
	font: PDFFont,
	boldFont: PDFFont
): number {
	const blockWidthPt = tb.width * COORD_SCALE;
	const paragraphs = sanitizeForWinAnsi(tb.text).split("\n");
	let totalHeight = 0;
	let charOffset = 0;

	for (let pi = 0; pi < paragraphs.length; pi++) {
		const para = paragraphs[pi];
		const style = tb.paragraphStyles.get(charOffset) ?? STYLE_PLAIN;
		const setting = getFontSetting(style);
		const activeFont = isBoldStyle(style) ? boldFont : font;
		const prefix = getStylePrefix(style, pi);

		if (para.trim()) {
			const lines = wrapText(prefix + para, blockWidthPt, activeFont, setting.fontSize);
			totalHeight += setting.lineHeight * lines.length;
		} else {
			totalHeight += setting.lineHeight;
		}
		charOffset += para.length + 1;
	}
	return totalHeight;
}

// --- Page geometry ---

interface PageGeometry {
	xOffset: number;
	yOffset: number;
	pageWidthPt: number;
	pageHeightPt: number;
}

function computePageGeometry(
	page: Page,
	_font: PDFFont,
	_boldFont: PDFFont
): PageGeometry {
	// .rm X coordinates are center-origin (-702..+702).
	// In screen space they sit at x + 810 (half of 1620 screen width).
	const halfScreenWidth = RM_SCREEN_WIDTH_PX / 2; // 810

	return {
		xOffset: halfScreenWidth,
		yOffset: 0,
		// Page dimensions stay the same (514 x 685.3pt for standard pages)
		pageWidthPt: RM_SCREEN_WIDTH_PX * COORD_SCALE, // 514pt
		pageHeightPt: page.height * SCALE, // 1872 * 514/1404 = 685.3pt
	};
}

function toPdf(
	x: number,
	y: number,
	geo: PageGeometry
): { px: number; py: number } {
	return {
		px: (x + geo.xOffset) * COORD_SCALE,
		py: geo.pageHeightPt - (y - geo.yOffset) * COORD_SCALE,
	};
}

// --- Rendering ---

async function renderStroke(
	pdfPage: PDFPage,
	stroke: Stroke,
	geo: PageGeometry,
	extGStates: Map<number, string>
): Promise<void> {
	if (!stroke.points || stroke.points.length < 2) return;

	// Skip eraser strokes
	if (stroke.penType === PenType.ERASER || stroke.penType === PenType.ERASER_AREA) return;

	const style = getPenStyle(stroke.penType);

	// Use ARGB color (tag 8) when available, otherwise fall back to color enum
	let color: { r: number; g: number; b: number };
	let opacity = style.opacity;
	if (stroke.colorArgb !== null) {
		const argb = getArgbColor(stroke.colorArgb);
		color = { r: argb.r, g: argb.g, b: argb.b };
		// For shader, the alpha channel encodes per-stroke opacity
		if (style.isHighlighter && stroke.penType === PenType.SHADER) {
			opacity = argb.a;
		}
	} else {
		color = getColor(stroke.color);
	}

	if (style.isHighlighter) {
		await renderHighlighterStroke(pdfPage, stroke, color, opacity, geo, extGStates);
		return;
	}

	// Normal strokes: draw segments
	for (let i = 1; i < stroke.points.length; i++) {
		const prev = stroke.points[i - 1];
		const curr = stroke.points[i];
		const w = pointWidthPt(curr, stroke.penType);
		const { px: x0, py: y0 } = toPdf(prev.x, prev.y, geo);
		const { px: x1, py: y1 } = toPdf(curr.x, curr.y, geo);

		pdfPage.drawLine({
			start: { x: x0, y: y0 },
			end: { x: x1, y: y1 },
			thickness: w,
			color: rgb(color.r, color.g, color.b),
			opacity,
			lineCap: LineCapStyle.Round,
		});
	}
}

async function renderHighlighterStroke(
	pdfPage: PDFPage,
	stroke: Stroke,
	color: { r: number; g: number; b: number },
	opacity: number,
	geo: PageGeometry,
	_extGStates: Map<number, string>
): Promise<void> {
	if (!stroke.points || stroke.points.length < 2) return;

	// Calculate median width using calibrated factor
	const widths = stroke.points.map((p) => p.width).sort((a, b) => a - b);
	const medianRaw = widths[Math.floor(widths.length / 2)] * SCALE * WIDTH_FACTOR;
	const medianW = Math.max(1.0, Math.min(medianRaw, 15.0));

	const effectiveOpacity = opacity;

	// Build a single SVG path to avoid opacity overlap at segment joints.
	// pdf-lib's drawSvgPath applies scale(1,-1) to convert SVG (Y-down) to PDF (Y-up).
	// We must pass SVG-space Y coords: svgY = pageHeight - pdfY.
	const first = toPdf(stroke.points[0].x, stroke.points[0].y, geo);
	let d = `M ${first.px.toFixed(2)} ${(geo.pageHeightPt - first.py).toFixed(2)}`;
	for (let i = 1; i < stroke.points.length; i++) {
		const pt = toPdf(stroke.points[i].x, stroke.points[i].y, geo);
		d += ` L ${pt.px.toFixed(2)} ${(geo.pageHeightPt - pt.py).toFixed(2)}`;
	}

	// Set round line join so segment joints aren't pointed
	pdfPage.pushOperators(setLineJoin(LineJoinStyle.Round));

	pdfPage.drawSvgPath(d, {
		borderColor: rgb(color.r, color.g, color.b),
		borderWidth: medianW,
		borderOpacity: effectiveOpacity,
		borderLineCap: LineCapStyle.Round,
		y: geo.pageHeightPt,
	});
}

async function renderTextBlock(
	pdfPage: PDFPage,
	tb: TextBlock,
	geo: PageGeometry,
	font: PDFFont,
	boldFont: PDFFont,
): Promise<void> {
	if (!tb.text.trim()) return;

	const { px: blockX } = toPdf(tb.posX, tb.posY, geo);
	const blockWidthPt = tb.width * COORD_SCALE;

	const sanitized = sanitizeForWinAnsi(tb.text);
	const paragraphs = sanitized.split("\n");

	// Render ALL paragraphs at the text block's actual posY.
	// Leading empty paragraphs are intentional — they position the text vertically.
	let cursorY = toPdf(0, tb.posY, geo).py;
	let charOffset = 0;

	for (let pi = 0; pi < paragraphs.length; pi++) {
		const para = paragraphs[pi];
		const style = tb.paragraphStyles.get(charOffset) ?? STYLE_PLAIN;
		const setting = getFontSetting(style);
		const activeFont = isBoldStyle(style) ? boldFont : font;
		const prefix = getStylePrefix(style, pi);

		if (para.trim()) {
			const lines = wrapText(prefix + para, blockWidthPt, activeFont, setting.fontSize);
			for (const line of lines) {
				cursorY -= setting.lineHeight;
				pdfPage.drawText(line, {
					x: blockX,
					y: cursorY,
					size: setting.fontSize,
					font: activeFont,
					color: rgb(0, 0, 0),
				});
			}
		} else {
			cursorY -= setting.lineHeight;
		}

		charOffset += para.length + 1;
	}
}

// --- Public API ---

export async function renderPageToPdf(
	page: Page,
	backgroundPdf?: Uint8Array
): Promise<Uint8Array> {
	const doc = await PDFDocument.create();

	const font = await doc.embedFont(StandardFonts.Helvetica);
	const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);

	const geo = computePageGeometry(page, font, boldFont);
	const pdfPage = doc.addPage([geo.pageWidthPt, geo.pageHeightPt]);

	const extGStates = new Map<number, string>();

	// Render highlighter/shader strokes FIRST (behind regular strokes)
	for (const layer of page.layers) {
		for (const stroke of layer.strokes) {
			const ps = getPenStyle(stroke.penType);
			if (ps.isHighlighter) {
				await renderStroke(pdfPage, stroke, geo, extGStates);
			}
		}
	}
	// Then render regular strokes on top
	for (const layer of page.layers) {
		for (const stroke of layer.strokes) {
			const ps = getPenStyle(stroke.penType);
			if (!ps.isHighlighter) {
				await renderStroke(pdfPage, stroke, geo, extGStates);
			}
		}
	}

	// Render text blocks
	for (const tb of page.textBlocks) {
		await renderTextBlock(pdfPage, tb, geo, font, boldFont);
	}

	const annotationBytes = await doc.save();

	// Merge with background if provided
	if (backgroundPdf) {
		return mergeWithBackground(annotationBytes, backgroundPdf);
	}

	return annotationBytes;
}

export async function renderNotebookToPdf(
	pages: Page[],
	backgroundPdfs?: (Uint8Array | null)[]
): Promise<Uint8Array> {
	const outputDoc = await PDFDocument.create();

	for (let i = 0; i < pages.length; i++) {
		const background = backgroundPdfs && i < backgroundPdfs.length ? backgroundPdfs[i] : null;
		const pagePdfBytes = await renderPageToPdf(pages[i], background ?? undefined);

		const pageDoc = await PDFDocument.load(pagePdfBytes);
		const copiedPages = await outputDoc.copyPages(pageDoc, pageDoc.getPageIndices());
		for (const p of copiedPages) {
			outputDoc.addPage(p);
		}
	}

	return outputDoc.save();
}

async function mergeWithBackground(
	annotationPdf: Uint8Array,
	backgroundPdf: Uint8Array
): Promise<Uint8Array> {
	try {
		const bgDoc = await PDFDocument.load(backgroundPdf);
		const annotDoc = await PDFDocument.load(annotationPdf);

		if (bgDoc.getPageCount() === 0) return annotationPdf;

		const bgPage = bgDoc.getPages()[0];

		if (annotDoc.getPageCount() > 0) {
			const [embeddedPage] = await bgDoc.embedPdf(annotDoc, [0]);
			const { width, height } = bgPage.getSize();
			bgPage.drawPage(embeddedPage, {
				x: 0,
				y: 0,
				width,
				height,
			});
		}

		return bgDoc.save();
	} catch {
		return annotationPdf;
	}
}
