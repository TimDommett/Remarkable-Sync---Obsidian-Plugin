/**
 * Template (page background) renderer.
 *
 * reMarkable notebooks record a per-page *template* name (e.g. "P Lines medium")
 * in the document's `.content` file. The template is the printed background a
 * page is drawn on: ruled lines, a grid, dots, a checklist, etc. reMarkable's
 * own templates are proprietary firmware assets that are NOT included in a cloud
 * sync, so we reproduce the common geometric ones as vector graphics here rather
 * than bundling reMarkable's artwork.
 *
 * Coordinates are screen pixels (1620 x 2160 on the Paper Pro), the same basis
 * pdf-renderer uses for strokes, so a template lines up with the annotations on
 * top of it. A screen point (sx, sy) maps to PDF points via:
 *     px = sx * coordScale
 *     py = pageHeightPt - sy * coordScale     (y is flipped; origin top-left)
 * which matches `toPdf` in pdf-renderer for a full-bleed background.
 */

import { PDFPage, rgb } from "pdf-lib";

// Light grey of reMarkable's printed rules, taken from its own PDF export
// (content-stream colour 0.752941 across r/g/b ≈ #C0C0C0).
const RULE_GREY = rgb(0.7529, 0.7529, 0.7529);

// Rule thickness in PDF points. reMarkable's export draws hair-thin rules; this
// is calibrated to stay visible in normal PDF viewers without overpowering ink.
const RULE_WIDTH_PT = 0.5;

// Medium spacing measured from reMarkable's own "Lines medium" / "Grid medium"
// exports: ~78.5 screen px between rules. Small/large are proportional estimates
// (only "medium" has ground-truth exports to calibrate against).
const SPACING_PX = { small: 52, medium: 78.5, large: 105 } as const;

// Screen-Y of the first ruled line, from reMarkable's "Lines medium" export
// (~177.8 px). Anchoring here keeps our rules at the same absolute positions
// reMarkable used, so handwriting that sat on its lines still sits on ours.
const LINES_TOP_MARGIN_PX = 178;

export type TemplateSize = keyof typeof SPACING_PX;
export type TemplateKind = "blank" | "lines" | "grid" | "dots" | "checklist";

export interface TemplateSpec {
	kind: TemplateKind;
	size: TemplateSize;
}

/** Geometry the page background is drawn into (subset of pdf-renderer's geo). */
export interface TemplateEnv {
	pageWidthPt: number;
	pageHeightPt: number;
	/** screen px → PDF points (COORD_SCALE in pdf-renderer). */
	coordScale: number;
}

/**
 * Resolve a reMarkable template name to a spec we can render.
 *
 * Returns a "blank" spec for blank / unset templates (nothing to draw, and not
 * worth warning about), and `null` for a template we don't yet support so the
 * caller can fall back to blank AND surface which template is missing.
 */
export function resolveTemplate(name: string | null | undefined): TemplateSpec | null {
	if (!name) return { kind: "blank", size: "medium" };
	const n = name.toLowerCase();

	if (n.includes("blank")) return { kind: "blank", size: "medium" };

	const size: TemplateSize = /\b(small|s)\b/.test(n) || n.endsWith(" s")
		? "small"
		: /\b(large|l|lg)\b/.test(n) || n.endsWith(" l")
			? "large"
			: "medium";

	// Order matters: check the more specific kinds before "lines", since a
	// checklist also contains rules and a grid also contains lines.
	if (n.includes("checklist") || n.includes("check list") || n.includes("todo")) {
		return { kind: "checklist", size };
	}
	if (n.includes("grid")) return { kind: "grid", size };
	if (n.includes("dot")) return { kind: "dots", size };
	if (n.includes("line") || n.includes("ruled") || n.includes("rule")) {
		return { kind: "lines", size };
	}

	return null;
}

/** Draw a template background onto a freshly created page, behind any strokes. */
export function drawTemplate(pdfPage: PDFPage, spec: TemplateSpec, env: TemplateEnv): void {
	switch (spec.kind) {
		case "blank":
			return;
		case "lines":
			drawHorizontalRules(pdfPage, spec, env, LINES_TOP_MARGIN_PX);
			return;
		case "grid":
			drawHorizontalRules(pdfPage, spec, env, SPACING_PX[spec.size]);
			drawVerticalRules(pdfPage, spec, env);
			return;
		case "dots":
			drawDots(pdfPage, spec, env);
			return;
		case "checklist":
			drawChecklist(pdfPage, spec, env);
			return;
	}
}

// --- Geometry helpers ---

function screenHeightPx(env: TemplateEnv): number {
	return env.pageHeightPt / env.coordScale;
}

function screenWidthPx(env: TemplateEnv): number {
	return env.pageWidthPt / env.coordScale;
}

function horizontalRule(pdfPage: PDFPage, syPx: number, env: TemplateEnv): void {
	const py = env.pageHeightPt - syPx * env.coordScale;
	pdfPage.drawLine({
		start: { x: 0, y: py },
		end: { x: env.pageWidthPt, y: py },
		thickness: RULE_WIDTH_PT,
		color: RULE_GREY,
	});
}

function verticalRule(pdfPage: PDFPage, sxPx: number, env: TemplateEnv): void {
	const px = sxPx * env.coordScale;
	pdfPage.drawLine({
		start: { x: px, y: 0 },
		end: { x: px, y: env.pageHeightPt },
		thickness: RULE_WIDTH_PT,
		color: RULE_GREY,
	});
}

// --- Template kinds ---

function drawHorizontalRules(
	pdfPage: PDFPage,
	spec: TemplateSpec,
	env: TemplateEnv,
	startPx: number
): void {
	const spacing = SPACING_PX[spec.size];
	const bottom = screenHeightPx(env);
	// Tile from the first rule to the bottom (covers height-extended long pages).
	for (let sy = startPx; sy <= bottom; sy += spacing) {
		horizontalRule(pdfPage, sy, env);
	}
}

function drawVerticalRules(pdfPage: PDFPage, spec: TemplateSpec, env: TemplateEnv): void {
	const spacing = SPACING_PX[spec.size];
	const width = screenWidthPx(env);
	// Centre the grid columns on the page so the margins are even.
	const count = Math.floor(width / spacing);
	const start = (width - count * spacing) / 2;
	for (let sx = start; sx <= width + 0.01; sx += spacing) {
		verticalRule(pdfPage, sx, env);
	}
}

function drawDots(pdfPage: PDFPage, spec: TemplateSpec, env: TemplateEnv): void {
	const spacing = SPACING_PX[spec.size];
	const width = screenWidthPx(env);
	const height = screenHeightPx(env);
	const colCount = Math.floor(width / spacing);
	const startX = (width - colCount * spacing) / 2;
	const radius = Math.max(0.6, 1.4 * env.coordScale * 2); // small visible dot
	for (let sy = spacing; sy <= height; sy += spacing) {
		const py = env.pageHeightPt - sy * env.coordScale;
		for (let sx = startX; sx <= width + 0.01; sx += spacing) {
			const px = sx * env.coordScale;
			pdfPage.drawCircle({ x: px, y: py, size: radius, color: RULE_GREY });
		}
	}
}

function drawChecklist(pdfPage: PDFPage, spec: TemplateSpec, env: TemplateEnv): void {
	// Checklist rows are taller than plain rules; use the next size up's spacing
	// so the boxes have room.
	const spacing = SPACING_PX[spec.size] * 1.3;
	const bottom = screenHeightPx(env);
	const boxPx = spacing * 0.42; // checkbox side, screen px
	const leftMarginPx = 96; // matches reMarkable's left gutter (~screen px)
	const boxX = leftMarginPx * env.coordScale;
	const boxSizePt = boxPx * env.coordScale;
	for (let sy = spacing * 1.5; sy <= bottom; sy += spacing) {
		const py = env.pageHeightPt - sy * env.coordScale;
		// Checkbox square (outline) sitting on the rule.
		pdfPage.drawRectangle({
			x: boxX,
			y: py,
			width: boxSizePt,
			height: boxSizePt,
			borderColor: RULE_GREY,
			borderWidth: RULE_WIDTH_PT,
		});
		// Rule to the right of the box for the item text.
		pdfPage.drawLine({
			start: { x: boxX + boxSizePt * 2, y: py },
			end: { x: env.pageWidthPt, y: py },
			thickness: RULE_WIDTH_PT,
			color: RULE_GREY,
		});
	}
}
