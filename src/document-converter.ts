/**
 * Document Converter
 *
 * Full pipeline from reMarkable ZIP archive to PDF:
 * 1. Extract .rm files and metadata from ZIP
 * 2. Parse .rm files to get strokes and text
 * 3. Render to PDF with optional background
 */

import { PDFDocument } from "pdf-lib";
import { parseRmFile, type Page } from "./rm-parser";
import { renderPageToPdf, renderNotebookToPdf } from "./pdf-renderer";

// --- Data structures ---

export interface PageInfo {
	pageId: string;
	rmData: Uint8Array | null;
	template: string | null;
	verticalScroll: number | null;
}

export interface DocumentContent {
	docId: string;
	docType: "notebook" | "pdf" | "epub";
	name: string;
	pages: PageInfo[];
	originalPdf: Uint8Array | null;
	originalEpub: Uint8Array | null;
	metadata: Record<string, any>;
}

// --- Converter ---

export class DocumentConverter {
	private docId: string;
	private files: Map<string, Uint8Array>;
	private content: DocumentContent | null = null;
	private contentInfo: Record<string, any> = {};

	constructor(docId: string, files: Map<string, Uint8Array>) {
		this.docId = docId;
		this.files = files;
	}

	private textOf(name: string): string {
		const data = this.files.get(name);
		if (!data) return "";
		return new TextDecoder().decode(data);
	}

	async parse(): Promise<DocumentContent> {
		if (this.content) return this.content;

		const fileList = Array.from(this.files.keys());

		const metadata = this.readMetadata(fileList);
		this.contentInfo = this.readContentInfo(fileList);
		const docType = this.determineDocType(this.contentInfo, fileList);
		const pages = this.extractPages(fileList, this.contentInfo);
		const originalPdf = this.extractOriginalPdf(fileList);
		const originalEpub = this.extractOriginalEpub(fileList);

		this.content = {
			docId: this.docId,
			docType,
			name: metadata.visibleName ?? "Untitled",
			pages,
			originalPdf,
			originalEpub,
			metadata,
		};

		return this.content;
	}

	async convertToPdf(): Promise<Uint8Array> {
		const content = await this.parse();

		if (content.pages.length === 0) {
			throw new Error(
				`No pages found in document (type: ${content.docType}). ` +
					`Documents with no rendered pages cannot be converted to PDF.`
			);
		}

		const parsedPages: Page[] = [];
		const backgroundPdfs: (Uint8Array | null)[] = [];

		for (let i = 0; i < content.pages.length; i++) {
			const pageInfo = content.pages[i];

			if (pageInfo.rmData) {
				try {
					const page = parseRmFile(new Uint8Array(pageInfo.rmData).buffer.slice(
						pageInfo.rmData.byteOffset,
						pageInfo.rmData.byteOffset + pageInfo.rmData.byteLength
					));
					page.pageId = pageInfo.pageId;

					// Extend the page height when stroke content runs past the
					// default page bounds (long / vertically scrolled pages) so it
					// is not clipped. See extendPageHeightForContent.
					extendPageHeightForContent(page);

					parsedPages.push(page);
				} catch {
					parsedPages.push(emptyPage(pageInfo.pageId));
				}
			} else {
				parsedPages.push(emptyPage(pageInfo.pageId));
			}

			if (content.originalPdf) {
				try {
					const bgPage = await this.extractPdfPage(content.originalPdf, i);
					backgroundPdfs.push(bgPage);
				} catch {
					backgroundPdfs.push(null);
				}
			} else {
				backgroundPdfs.push(null);
			}
		}

		if (parsedPages.length === 1) {
			return renderPageToPdf(parsedPages[0], backgroundPdfs[0] ?? undefined);
		}
		return renderNotebookToPdf(parsedPages, backgroundPdfs);
	}

	// --- Archive processing ---

	private readMetadata(fileList: string[]): Record<string, any> {
		for (const name of fileList) {
			if (name.endsWith(".metadata")) {
				try {
					return JSON.parse(this.textOf(name));
				} catch {
					// ignore
				}
			}
		}
		return {};
	}

	private readContentInfo(fileList: string[]): Record<string, any> {
		for (const name of fileList) {
			if (name.endsWith(".content")) {
				try {
					return JSON.parse(this.textOf(name));
				} catch {
					// ignore
				}
			}
		}
		return {};
	}

	private determineDocType(
		contentInfo: Record<string, any>,
		fileList: string[]
	): "notebook" | "pdf" | "epub" {
		for (const name of fileList) {
			if (name.endsWith(".pdf")) return "pdf";
			if (name.endsWith(".epub")) return "epub";
		}
		const fileType = contentInfo.fileType ?? "";
		if (fileType === "pdf") return "pdf";
		if (fileType === "epub") return "epub";
		return "notebook";
	}

	private extractPages(
		fileList: string[],
		contentInfo: Record<string, any>
	): PageInfo[] {
		let pageIds: string[] = contentInfo.pages ?? [];

		// Check cPages (newer format) and extract per-page metadata
		const cPages = contentInfo.cPages;
		const pageVerticalScroll = new Map<string, number>();
		if (cPages && cPages.pages) {
			pageIds = cPages.pages.map((p: any) => {
				const id = typeof p === "object" ? p.id ?? p : p;
				if (typeof p === "object" && p.verticalScroll?.value != null) {
					pageVerticalScroll.set(id, p.verticalScroll.value);
				}
				return id;
			});
		}

		// Fallback: scan for .rm files
		if (pageIds.length === 0) {
			for (const name of fileList) {
				if (name.endsWith(".rm")) {
					const stem = name.replace(/^.*\//, "").replace(/\.rm$/, "");
					if (!pageIds.includes(stem)) {
						pageIds.push(stem);
					}
				}
			}
		}

		const pages: PageInfo[] = [];

		for (const pageId of pageIds) {
			const pageInfo: PageInfo = {
				pageId,
				rmData: null,
				template: null,
				verticalScroll: pageVerticalScroll.get(pageId) ?? null,
			};

			// Find .rm file
			for (const name of fileList) {
				if (name.endsWith(`${pageId}.rm`)) {
					pageInfo.rmData = this.files.get(name) ?? null;
					break;
				}
			}

			// Find page metadata
			for (const name of fileList) {
				if (name.includes(`${pageId}-metadata.json`)) {
					try {
						const meta = JSON.parse(this.textOf(name));
						pageInfo.template = meta.template ?? null;
					} catch {
						// ignore
					}
				}
			}

			pages.push(pageInfo);
		}

		// Final fallback: grab any .rm files
		if (pages.length === 0) {
			for (const name of fileList) {
				if (name.endsWith(".rm")) {
					const stem = name.replace(/^.*\//, "").replace(/\.rm$/, "");
					const rmData = this.files.get(name) ?? null;
					pages.push({ pageId: stem, rmData, template: null, verticalScroll: null });
				}
			}
		}

		return pages;
	}

	private extractOriginalPdf(fileList: string[]): Uint8Array | null {
		for (const name of fileList) {
			if (name.endsWith(".pdf") && !name.endsWith("-metadata.pdf")) {
				return this.files.get(name) ?? null;
			}
		}
		return null;
	}

	private extractOriginalEpub(fileList: string[]): Uint8Array | null {
		for (const name of fileList) {
			if (name.endsWith(".epub")) {
				return this.files.get(name) ?? null;
			}
		}
		return null;
	}

	private async extractPdfPage(
		pdfData: Uint8Array,
		pageNum: number
	): Promise<Uint8Array | null> {
		try {
			const srcDoc = await PDFDocument.load(pdfData);
			if (pageNum >= srcDoc.getPageCount()) return null;

			const newDoc = await PDFDocument.create();
			const [copiedPage] = await newDoc.copyPages(srcDoc, [pageNum]);
			newDoc.addPage(copiedPage);
			return new Uint8Array(await newDoc.save());
		} catch {
			return null;
		}
	}
}

// Extend the page height when stroke content runs past the default page bounds
// (long / vertically scrolled pages) so it is not clipped in the rendered PDF.
// This is content-driven and independent of the optional `verticalScroll`
// metadata — long pages that lack it would otherwise be silently truncated.
// Pages whose strokes stay within the default height are left untouched, so it
// can never affect normal single-screen pages. The 0.885 factor maps raw
// stroke-coordinate bounds to reMarkable's export bounds (calibrated against
// reference_sheets/). Shared with the re-render.ts reference tool so both paths
// stay in sync.
export function extendPageHeightForContent(page: Page): void {
	const defaultHeight = page.height; // 1872 for standard pages
	const threshold = defaultHeight * 1.05;
	let maxY = 0;
	for (const layer of page.layers) {
		for (const stroke of layer.strokes) {
			for (const pt of stroke.points) {
				if (pt.y > maxY) maxY = pt.y;
			}
		}
	}
	const scaledHeight = maxY * 0.885;
	if (scaledHeight > threshold) {
		page.height = scaledHeight;
	}
}

function emptyPage(pageId: string): Page {
	return {
		pageId,
		layers: [],
		textSpans: [],
		textBlocks: [],
		width: 1404,
		height: 1872,
	};
}

export async function convertDocument(
	docId: string,
	files: Map<string, Uint8Array>
): Promise<Uint8Array> {
	const converter = new DocumentConverter(docId, files);
	return converter.convertToPdf();
}
