/**
 * reMarkable v6 .rm File Parser
 *
 * Parses the v6 binary format used by reMarkable software version 3+
 * (including Paper Pro).
 *
 * Based on / inspired by rmscene by Rick Lupton
 * https://github.com/ricklupton/rmscene
 * Licensed under the MIT License
 * Copyright (c) 2023 Rick Lupton
 *
 * Block format: u32 LE (length) + u8 (reserved) + u8 (minV) + u8 (curV) + u8 (type)
 * Tag format: varint where index = varint >> 4, type = varint & 0xF
 */

// --- Constants ---

const HEADER_LENGTH = 43; // "reMarkable .lines file, version=6" + padding

const BLOCK_SCENE_TREE = 1;
const BLOCK_TREE_NODE = 2;
const BLOCK_LINE_ITEM = 5;
const BLOCK_ROOT_TEXT = 7;

// Tag types
const TAG_BYTE1 = 0x1;
const TAG_BYTE4 = 0x4;
const TAG_BYTE8 = 0x8;
const TAG_LENGTH4 = 0xC;
const TAG_ID = 0xF;

// Item types within value subblocks
const ITEM_LINE = 3;

// --- CrdtId type ---

type CrdtId = [number, number];

function readCrdtId(reader: BinaryReader): CrdtId {
	const part1 = reader.readU8();
	const part2 = reader.readVarint();
	return [part1, part2];
}

function crdtKey(id: CrdtId): string {
	return `${id[0]}:${id[1]}`;
}

// --- Scene tree types ---

interface SceneTreeEntry {
	treeId: CrdtId;
	nodeId: CrdtId;
	parentId: CrdtId;
}

interface TreeNodeData {
	nodeId: CrdtId;
	anchorOriginX: number | null;
	anchorOriginY: number | null;
	anchorId: CrdtId | null;
}

// --- Text CRDT types ---

interface CrdtTextItem {
	itemId: CrdtId;
	leftId: CrdtId;
	rightId: CrdtId;
	deletedLength: number;
	value: string | number; // string for text content, number for inline format code
}

interface CrdtTextFormat {
	charId: CrdtId;
	formatCode: number;
}

// --- Enums ---

export enum PenType {
	BRUSH = 0,
	PENCIL_1 = 1,
	BALLPOINT_1 = 2,
	MARKER_1 = 3,
	FINELINER_1 = 4,
	HIGHLIGHTER_1 = 5,
	ERASER = 6,
	MECHANICAL_PENCIL_1 = 7,
	ERASER_AREA = 8,
	PAINTBRUSH_2 = 12,
	MECHANICAL_PENCIL_2 = 13,
	PENCIL_2 = 14,
	BALLPOINT_2 = 15,
	MARKER_2 = 16,
	FINELINER_2 = 17,
	HIGHLIGHTER_2 = 18,
	CALLIGRAPHY = 21,
	SHADER = 23,
}

// --- Data structures ---

export interface Point {
	x: number;
	y: number;
	speed: number;
	direction: number;
	width: number;
	pressure: number;
}

export interface Stroke {
	penType: number;
	color: number;
	colorArgb: number | null; // ARGB color from tag 8 (v2 color), used by highlighter/shader
	thicknessScale: number;
	points: Point[];
}

export interface TextSpan {
	text: string;
	bold: boolean;
	italic: boolean;
}

export interface TextBlock {
	text: string;
	posX: number;
	posY: number;
	width: number;
	paragraphStyles: Map<number, number>;
}

export interface Layer {
	name: string;
	strokes: Stroke[];
}

export interface Page {
	pageId: string;
	layers: Layer[];
	textSpans: TextSpan[];
	textBlocks: TextBlock[];
	width: number;
	height: number;
}

// --- Binary reader ---

class BinaryReader {
	private view: DataView;
	private pos: number;
	private length: number;

	constructor(buffer: ArrayBuffer, offset = 0, length?: number) {
		this.view = new DataView(buffer, offset, length);
		this.pos = 0;
		this.length = length ?? buffer.byteLength - offset;
	}

	tell(): number { return this.pos; }
	seek(pos: number): void { this.pos = pos; }
	remaining(): number { return this.length - this.pos; }

	readU8(): number {
		if (this.pos >= this.length) throw new Error("EOF");
		return this.view.getUint8(this.pos++);
	}

	readU16(): number {
		if (this.pos + 2 > this.length) throw new Error("EOF");
		const val = this.view.getUint16(this.pos, true);
		this.pos += 2;
		return val;
	}

	readU32(): number {
		if (this.pos + 4 > this.length) throw new Error("EOF");
		const val = this.view.getUint32(this.pos, true);
		this.pos += 4;
		return val;
	}

	readF32(): number {
		if (this.pos + 4 > this.length) throw new Error("EOF");
		const val = this.view.getFloat32(this.pos, true);
		this.pos += 4;
		return val;
	}

	readF64(): number {
		if (this.pos + 8 > this.length) throw new Error("EOF");
		const val = this.view.getFloat64(this.pos, true);
		this.pos += 8;
		return val;
	}

	readVarint(): number {
		let result = 0;
		let shift = 0;
		while (true) {
			if (this.pos >= this.length) throw new Error("EOF");
			const b = this.view.getUint8(this.pos++);
			result |= (b & 0x7f) << shift;
			if ((b & 0x80) === 0) break;
			shift += 7;
		}
		return result;
	}

	readBytes(n: number): Uint8Array {
		if (this.pos + n > this.length) throw new Error("EOF");
		const bytes = new Uint8Array(n);
		for (let i = 0; i < n; i++) {
			bytes[i] = this.view.getUint8(this.pos++);
		}
		return bytes;
	}

	skip(n: number): void {
		this.pos += n;
	}

	slice(offset: number, length: number): BinaryReader {
		const bufferOffset = this.view.byteOffset + offset;
		return new BinaryReader(this.view.buffer, bufferOffset, length);
	}
}

// --- Tag helpers ---

interface Tag {
	index: number;
	type: number;
}

function readTag(reader: BinaryReader): Tag {
	const raw = reader.readVarint();
	return { index: raw >> 4, type: raw & 0xF };
}

function skipTagValue(reader: BinaryReader, tag: Tag): void {
	switch (tag.type) {
		case TAG_BYTE1: reader.skip(1); break;
		case TAG_BYTE4: reader.skip(4); break;
		case TAG_BYTE8: reader.skip(8); break;
		case TAG_LENGTH4: {
			const len = reader.readU32();
			reader.skip(len);
			break;
		}
		case TAG_ID: {
			reader.skip(1);
			reader.readVarint();
			break;
		}
		default:
			reader.readVarint();
	}
}

// --- Scene tree parsing ---

function parseSceneTreeBlock(reader: BinaryReader): SceneTreeEntry | null {
	let treeId: CrdtId | null = null;
	let nodeId: CrdtId | null = null;
	let parentId: CrdtId = [0, 0];

	while (reader.remaining() > 0) {
		const tag = readTag(reader);
		if (tag.index === 1 && tag.type === TAG_ID) {
			treeId = readCrdtId(reader);
		} else if (tag.index === 2 && tag.type === TAG_ID) {
			nodeId = readCrdtId(reader);
		} else if (tag.index === 3 && tag.type === TAG_BYTE1) {
			reader.skip(1);
		} else if (tag.index === 4 && tag.type === TAG_LENGTH4) {
			const len = reader.readU32();
			const subReader = reader.slice(reader.tell(), len);
			while (subReader.remaining() > 0) {
				const stag = readTag(subReader);
				if (stag.index === 1 && stag.type === TAG_ID) {
					parentId = readCrdtId(subReader);
				} else {
					skipTagValue(subReader, stag);
				}
			}
			reader.skip(len);
		} else {
			skipTagValue(reader, tag);
		}
	}

	if (!treeId || !nodeId) return null;
	return { treeId, nodeId, parentId };
}

function parseTreeNodeBlock(reader: BinaryReader): TreeNodeData | null {
	let nodeId: CrdtId | null = null;
	let anchorOriginX: number | null = null;
	let anchorOriginY: number | null = null;
	let anchorId: CrdtId | null = null;

	while (reader.remaining() > 0) {
		const tag = readTag(reader);
		if (tag.index === 1 && tag.type === TAG_ID) {
			nodeId = readCrdtId(reader);
		} else if (tag.index === 7 && tag.type === TAG_LENGTH4) {
			// LwwValue[CrdtId] for anchor_id — links group to a text character
			const len = reader.readU32();
			const subReader = reader.slice(reader.tell(), len);
			while (subReader.remaining() > 0) {
				const lwwTag = readTag(subReader);
				if (lwwTag.index === 1 && lwwTag.type === TAG_ID) {
					readCrdtId(subReader); // timestamp — skip
				} else if (lwwTag.index === 2 && lwwTag.type === TAG_ID) {
					anchorId = readCrdtId(subReader);
				} else {
					skipTagValue(subReader, lwwTag);
				}
			}
			reader.skip(len);
		} else if (tag.index === 10 && tag.type === TAG_LENGTH4) {
			// LwwValue[float] for anchor_origin_x
			const len = reader.readU32();
			const subReader = reader.slice(reader.tell(), len);
			while (subReader.remaining() > 0) {
				const lwwTag = readTag(subReader);
				if (lwwTag.index === 1 && lwwTag.type === TAG_ID) {
					readCrdtId(subReader); // timestamp — skip
				} else if (lwwTag.index === 2 && lwwTag.type === TAG_BYTE4) {
					anchorOriginX = subReader.readF32();
				} else {
					skipTagValue(subReader, lwwTag);
				}
			}
			reader.skip(len);
		} else if (tag.index === 13 && tag.type === TAG_LENGTH4) {
			// LwwValue[float] for anchor_origin_y (tag 13)
			const len = reader.readU32();
			const subReader = reader.slice(reader.tell(), len);
			while (subReader.remaining() > 0) {
				const lwwTag = readTag(subReader);
				if (lwwTag.index === 1 && lwwTag.type === TAG_ID) {
					readCrdtId(subReader);
				} else if (lwwTag.index === 2 && lwwTag.type === TAG_BYTE4) {
					anchorOriginY = subReader.readF32();
				} else {
					skipTagValue(subReader, lwwTag);
				}
			}
			reader.skip(len);
		} else {
			skipTagValue(reader, tag);
		}
	}

	if (!nodeId) return null;
	return { nodeId, anchorOriginX, anchorOriginY, anchorId };
}

function computeOffsetForNode(
	nodeTreeId: CrdtId,
	entryByTreeId: Map<string, SceneTreeEntry>,
	nodes: Map<string, TreeNodeData>
): { x: number; y: number } {
	// Walk from nodeTreeId up to root, accumulating anchor_origin_x and anchor_origin_y.
	let xOffset = 0;
	let yOffset = 0;
	let currentKey = crdtKey(nodeTreeId);
	const visited = new Set<string>();

	while (currentKey && currentKey !== "0:0") {
		if (visited.has(currentKey)) break;
		visited.add(currentKey);

		const nd = nodes.get(currentKey);
		if (nd?.anchorOriginX != null) {
			xOffset += nd.anchorOriginX;
		}
		if (nd?.anchorOriginY != null) {
			yOffset += nd.anchorOriginY;
		}

		// Walk to parent via SceneTreeBlock
		const entry = entryByTreeId.get(currentKey);
		if (!entry) break;
		currentKey = crdtKey(entry.parentId);
	}

	return { x: xOffset, y: yOffset };
}

// --- Text anchor Y positioning ---

// Line heights in reMarkable pixels, matching pdf-renderer.ts font settings.
// Computed as: lineHeightPt * (RM_WIDTH_PX / RM_WIDTH_PT) = lineHeightPt * 1404/514
const RM_PX_PER_PT = 1404 / 514;
const STYLE_PLAIN = 1;
const STYLE_HEADING = 2;
const STYLE_BOLD = 3;

function getLineHeightPx(style: number): number {
	switch (style) {
		case STYLE_HEADING: return 26 * RM_PX_PER_PT;
		case STYLE_BOLD: return 23 * RM_PX_PER_PT;
		default: return 23 * RM_PX_PER_PT;
	}
}

function computeAnchorYOffset(tb: TextBlock, anchorCharOffset: number): number {
	const paragraphs = tb.text.split("\n");
	let yOffset = tb.posY;
	let charOff = 0;

	for (let i = 0; i < paragraphs.length; i++) {
		const style = tb.paragraphStyles.get(charOff) ?? STYLE_PLAIN;
		yOffset += getLineHeightPx(style);
		charOff += paragraphs[i].length + 1; // +1 for newline
		if (charOff > anchorCharOffset) break;
	}

	return yOffset;
}

// --- RootText parsing ---

interface RootTextResult {
	textBlock: TextBlock;
	charPositions: Map<string, number>;
}

function parseRootTextBlock(reader: BinaryReader): RootTextResult | null {
	let posX = -576.0;
	let posY = 234.0;
	let width = 1152.0;
	const textItems: CrdtTextItem[] = [];
	const textFormats: CrdtTextFormat[] = [];

	while (reader.remaining() > 0) {
		const tag = readTag(reader);
		if (tag.index === 1 && tag.type === TAG_ID) {
			readCrdtId(reader); // block_id — skip
		} else if (tag.index === 2 && tag.type === TAG_LENGTH4) {
			const len = reader.readU32();
			const subReader = reader.slice(reader.tell(), len);
			try { parseTextContent(subReader, textItems, textFormats); } catch { /* skip */ }
			reader.skip(len);
		} else if (tag.index === 3 && tag.type === TAG_LENGTH4) {
			const len = reader.readU32();
			const subReader = reader.slice(reader.tell(), len);
			if (subReader.remaining() >= 16) {
				posX = subReader.readF64();
				posY = subReader.readF64();
			}
			reader.skip(len);
		} else if (tag.index === 4 && tag.type === TAG_BYTE4) {
			width = reader.readF32();
		} else {
			skipTagValue(reader, tag);
		}
	}

	const resolved = resolveTextContent(textItems, textFormats);
	if (!resolved.text.trim()) return null;

	return {
		textBlock: { text: resolved.text, posX, posY, width, paragraphStyles: resolved.paragraphStyles },
		charPositions: resolved.charPositions,
	};
}

function parseTextContent(
	reader: BinaryReader,
	textItems: CrdtTextItem[],
	textFormats: CrdtTextFormat[]
): void {
	while (reader.remaining() > 0) {
		const tag = readTag(reader);
		if (tag.index === 1 && tag.type === TAG_LENGTH4) {
			const len = reader.readU32();
			const subReader = reader.slice(reader.tell(), len);
			try { parseTextItemsContainer(subReader, textItems); } catch { /* skip */ }
			reader.skip(len);
		} else if (tag.index === 2 && tag.type === TAG_LENGTH4) {
			const len = reader.readU32();
			const subReader = reader.slice(reader.tell(), len);
			try { parseFormattingContainer(subReader, textFormats); } catch { /* skip */ }
			reader.skip(len);
		} else {
			skipTagValue(reader, tag);
		}
	}
}

function parseTextItemsContainer(reader: BinaryReader, textItems: CrdtTextItem[]): void {
	while (reader.remaining() > 0) {
		const tag = readTag(reader);
		if (tag.index === 1 && tag.type === TAG_LENGTH4) {
			const len = reader.readU32();
			const subReader = reader.slice(reader.tell(), len);
			try { parseTextItemList(subReader, textItems); } catch { /* skip */ }
			reader.skip(len);
		} else {
			skipTagValue(reader, tag);
		}
	}
}

function parseTextItemList(reader: BinaryReader, textItems: CrdtTextItem[]): void {
	const numItems = reader.readVarint();
	for (let i = 0; i < numItems && reader.remaining() > 0; i++) {
		const tag = readTag(reader);
		if (tag.type === TAG_LENGTH4) {
			const len = reader.readU32();
			const subReader = reader.slice(reader.tell(), len);
			try {
				const item = parseTextItem(subReader);
				if (item) textItems.push(item);
			} catch { /* skip */ }
			reader.skip(len);
		} else {
			skipTagValue(reader, tag);
		}
	}
}

function parseTextItem(reader: BinaryReader): CrdtTextItem | null {
	let itemId: CrdtId | null = null;
	let leftId: CrdtId = [0, 0];
	let rightId: CrdtId = [0, 0];
	let deletedLength = 0;
	let value: string | number = "";

	while (reader.remaining() > 0) {
		const tag = readTag(reader);
		if (tag.index === 2 && tag.type === TAG_ID) {
			itemId = readCrdtId(reader);
		} else if (tag.index === 3 && tag.type === TAG_ID) {
			leftId = readCrdtId(reader);
		} else if (tag.index === 4 && tag.type === TAG_ID) {
			rightId = readCrdtId(reader);
		} else if (tag.index === 5 && tag.type === TAG_BYTE4) {
			deletedLength = reader.readU32();
		} else if (tag.index === 6 && tag.type === TAG_LENGTH4) {
			const len = reader.readU32();
			const subReader = reader.slice(reader.tell(), len);
			try {
				const result = parseTextValue(subReader);
				if (result.formatCode !== null) {
					// Format code item: value is the format code number
					value = result.formatCode;
				} else {
					value = result.text;
				}
			} catch { /* skip */ }
			reader.skip(len);
		} else {
			skipTagValue(reader, tag);
		}
	}

	if (!itemId) return null;
	return { itemId, leftId, rightId, deletedLength, value };
}

function parseTextValue(reader: BinaryReader): { text: string; formatCode: number | null } {
	const strLen = reader.readVarint();
	const _isAscii = reader.readU8();

	let text = "";
	if (strLen > 0 && reader.remaining() >= strLen) {
		const bytes = reader.readBytes(strLen);
		try {
			text = new TextDecoder("utf-8").decode(bytes);
		} catch {
			text = String.fromCharCode(...bytes);
		}
	}

	// Check for format code tag(2, Byte4) after the string
	let formatCode: number | null = null;
	if (reader.remaining() >= 2) {
		const pos = reader.tell();
		try {
			const tag = readTag(reader);
			if (tag.index === 2 && tag.type === TAG_BYTE4) {
				formatCode = reader.readU32();
			} else {
				reader.seek(pos);
			}
		} catch {
			reader.seek(pos);
		}
	}

	return { text, formatCode };
}

function parseFormattingContainer(reader: BinaryReader, textFormats: CrdtTextFormat[]): void {
	while (reader.remaining() > 0) {
		const tag = readTag(reader);
		if (tag.index === 1 && tag.type === TAG_LENGTH4) {
			const len = reader.readU32();
			const subReader = reader.slice(reader.tell(), len);
			try { parseFormatList(subReader, textFormats); } catch { /* skip */ }
			reader.skip(len);
		} else {
			skipTagValue(reader, tag);
		}
	}
}

function parseFormatList(reader: BinaryReader, textFormats: CrdtTextFormat[]): void {
	// Format entries are NOT wrapped in tag subblocks (unlike text items).
	// Each entry is: raw CrdtId + tag(1,ID) timestamp + tag(2,Length4) format subblock
	const numFormats = reader.readVarint();
	for (let i = 0; i < numFormats && reader.remaining() > 0; i++) {
		const fmt = parseFormatEntry(reader);
		if (fmt) textFormats.push(fmt);
	}
}

function parseFormatEntry(reader: BinaryReader): CrdtTextFormat | null {
	// Raw CrdtId (no tag prefix) for character position
	const charId = readCrdtId(reader);
	let formatCode = 1; // default: PLAIN

	while (reader.remaining() > 0) {
		const tag = readTag(reader);
		if (tag.index === 1 && tag.type === TAG_ID) {
			readCrdtId(reader); // timestamp — skip
		} else if (tag.index === 2 && tag.type === TAG_LENGTH4) {
			const len = reader.readU32();
			const subReader = reader.slice(reader.tell(), len);
			if (subReader.remaining() >= 2) {
				subReader.readU8(); // marker byte (17)
				formatCode = subReader.readU8();
			}
			reader.skip(len);
			break; // Done with this format entry
		} else {
			skipTagValue(reader, tag);
		}
	}

	return { charId, formatCode };
}

// --- CRDT text expansion ---

function expandTextItem(item: CrdtTextItem): CrdtTextItem[] {
	if (item.deletedLength > 0) {
		// Deleted item: expand to deletedLength single-char items
		const chars: string[] = Array(item.deletedLength).fill("");
		return expandChars(item, chars, 1);
	}
	if (typeof item.value === "number") {
		// Format code: return as-is (single entity, no expansion)
		return [item];
	}
	// Text string: expand each character into its own item
	const text = item.value;
	if (!text || text.length === 0) return [];
	return expandChars(item, [...text], 0);
}

function expandChars(
	item: CrdtTextItem,
	chars: string[],
	deletedLength: number
): CrdtTextItem[] {
	if (chars.length === 0) return [];
	const result: CrdtTextItem[] = [];
	let itemId = item.itemId;
	let leftId = item.leftId;

	for (let i = 0; i < chars.length - 1; i++) {
		const rightId: CrdtId = [itemId[0], itemId[1] + 1];
		result.push({ itemId, leftId, rightId, deletedLength, value: chars[i] });
		leftId = itemId;
		itemId = rightId;
	}
	// Last character uses the original item's rightId
	result.push({ itemId, leftId, rightId: item.rightId, deletedLength, value: chars[chars.length - 1] });
	return result;
}

function expandTextItems(items: CrdtTextItem[]): CrdtTextItem[] {
	const result: CrdtTextItem[] = [];
	for (const item of items) {
		result.push(...expandTextItem(item));
	}
	return result;
}

// --- Topological sort ---

function compareCrdtId(a: CrdtId, b: CrdtId): number {
	if (a[0] !== b[0]) return a[0] - b[0];
	return a[1] - b[1];
}

const END_MARKER_KEY = "0:0";
const START_SENTINEL = "__start";
const END_SENTINEL = "__end";

function toposortItems(items: CrdtTextItem[]): CrdtId[] {
	const itemDict = new Map<string, CrdtTextItem>();
	for (const item of items) {
		itemDict.set(crdtKey(item.itemId), item);
	}
	if (itemDict.size === 0) return [];

	function sideId(item: CrdtTextItem, side: "left" | "right"): string {
		const id = side === "left" ? item.leftId : item.rightId;
		const key = crdtKey(id);
		if (key === END_MARKER_KEY || !itemDict.has(key)) {
			return side === "left" ? START_SENTINEL : END_SENTINEL;
		}
		return key;
	}

	// Build dependency graph: key "comes after" all values in its set
	const data = new Map<string, Set<string>>();
	const getOrCreate = (key: string): Set<string> => {
		let s = data.get(key);
		if (!s) { s = new Set(); data.set(key, s); }
		return s;
	};

	for (const item of itemDict.values()) {
		const key = crdtKey(item.itemId);
		const leftKey = sideId(item, "left");
		const rightKey = sideId(item, "right");
		getOrCreate(key).add(leftKey);     // item comes after its left neighbor
		getOrCreate(rightKey).add(key);    // right neighbor comes after this item
	}

	// Fill in dependency sources that aren't keys yet
	const allDeps = new Set<string>();
	for (const deps of data.values()) {
		for (const dep of deps) allDeps.add(dep);
	}
	for (const dep of allDeps) {
		if (!data.has(dep)) data.set(dep, new Set());
	}

	// Kahn's algorithm: repeatedly yield items with no remaining dependencies
	const result: CrdtId[] = [];
	while (true) {
		const ready: string[] = [];
		for (const [key, deps] of data) {
			if (deps.size === 0) ready.push(key);
		}

		if (ready.length === 1 && ready[0] === END_SENTINEL) break;
		if (ready.length === 0) break; // safety: no progress possible

		// Sort ready items by CrdtId for deterministic ordering
		const readyReal = ready
			.filter(k => itemDict.has(k))
			.map(k => itemDict.get(k)!)
			.sort((a, b) => compareCrdtId(a.itemId, b.itemId));

		for (const item of readyReal) {
			result.push(item.itemId);
		}

		// Remove ready items from the graph
		const readySet = new Set(ready);
		for (const key of ready) {
			data.delete(key);
		}
		for (const deps of data.values()) {
			for (const dep of readySet) {
				deps.delete(dep);
			}
		}
	}

	return result;
}

// --- CRDT text resolution ---

interface ResolvedText {
	text: string;
	paragraphStyles: Map<number, number>;
	charPositions: Map<string, number>; // CrdtId key → char offset in resolved text
}

function resolveTextContent(
	items: CrdtTextItem[],
	formats: CrdtTextFormat[]
): ResolvedText {
	// Expand multi-char items into single-char items with explicit IDs
	const expanded = expandTextItems(items);
	// Topological sort to get correct ordering
	const sortedIds = toposortItems(expanded);

	// Build id → item map for value lookup
	const itemMap = new Map<string, CrdtTextItem>();
	for (const item of expanded) {
		itemMap.set(crdtKey(item.itemId), item);
	}

	// Build result string and char positions map in a single pass
	const result: string[] = [];
	const charPositions = new Map<string, number>();
	let offset = 0;
	for (const id of sortedIds) {
		const item = itemMap.get(crdtKey(id));
		if (!item) continue;
		if (item.deletedLength > 0) continue;
		if (typeof item.value === "number") continue; // skip format codes
		charPositions.set(crdtKey(id), offset);
		if (item.value) {
			result.push(item.value);
			offset += item.value.length;
		}
	}

	// Map format CrdtIds to paragraph start offsets
	const paragraphStyles = new Map<number, number>();
	for (const fmt of formats) {
		const key = crdtKey(fmt.charId);
		if (fmt.charId[0] === 0 && fmt.charId[1] === 0) {
			paragraphStyles.set(0, fmt.formatCode);
		} else {
			const charOffset = charPositions.get(key);
			if (charOffset !== undefined) {
				paragraphStyles.set(charOffset + 1, fmt.formatCode);
			}
		}
	}

	return {
		text: result.join(""),
		paragraphStyles,
		charPositions,
	};
}

// --- Main parser ---

export function parseRmFile(data: ArrayBuffer, debug = false): Page {
	const reader = new BinaryReader(data);

	// Collect line items with their parent group IDs
	const lineItems: LineItemResult[] = [];

	// Scene tree data
	const sceneTreeEntries: SceneTreeEntry[] = [];
	const treeNodeMap = new Map<string, TreeNodeData>();
	let textResult: RootTextResult | null = null;

	// Skip header (exactly 43 bytes)
	if (reader.remaining() < HEADER_LENGTH + 8) {
		throw new Error("File too small");
	}
	reader.skip(HEADER_LENGTH);

	// Parse blocks
	let blockCount = 0;
	while (reader.remaining() >= 8) {
		try {
			const blockLen = reader.readU32();
			const _reserved = reader.readU8();
			const _minV = reader.readU8();
			const curV = reader.readU8();
			const blockType = reader.readU8();

			const contentStart = reader.tell();
			const contentEnd = contentStart + blockLen;

			if (contentEnd > data.byteLength) {
				if (debug) console.log(`  Block #${blockCount}: type=${blockType} extends beyond file, stopping`);
				break;
			}

			if (blockType === BLOCK_LINE_ITEM && blockLen > 0) {
				const contentReader = reader.slice(contentStart, blockLen);
				try {
					const result = parseLineItemBlock(contentReader, debug);
					if (result && result.stroke.points.length > 0) {
						lineItems.push(result);
					}
				} catch {
					// Skip malformed line item
				}
			} else if (blockType === BLOCK_SCENE_TREE && blockLen > 0) {
				const contentReader = reader.slice(contentStart, blockLen);
				try {
					const entry = parseSceneTreeBlock(contentReader);
					if (entry) sceneTreeEntries.push(entry);
				} catch { /* skip */ }
			} else if (blockType === BLOCK_TREE_NODE && blockLen > 0) {
				const contentReader = reader.slice(contentStart, blockLen);
				try {
					const node = parseTreeNodeBlock(contentReader);
					if (node) treeNodeMap.set(crdtKey(node.nodeId), node);
				} catch { /* skip */ }
			} else if (blockType === BLOCK_ROOT_TEXT && blockLen > 0) {
				const contentReader = reader.slice(contentStart, blockLen);
				try {
					textResult = parseRootTextBlock(contentReader);
				} catch { /* skip */ }
			}

			reader.seek(contentEnd);
			blockCount++;
		} catch {
			break;
		}
	}

	// Build tree_id → entry map for walking parent chain
	const entryByTreeId = new Map<string, SceneTreeEntry>();
	for (const entry of sceneTreeEntries) {
		entryByTreeId.set(crdtKey(entry.treeId), entry);
	}

	const textBlock = textResult?.textBlock ?? null;
	const charPositions = textResult?.charPositions ?? null;

	// Apply per-line offsets based on each line's parent group:
	// - X offset from anchor_origin_x (tree walk)
	// - Y offset from text anchor (anchor_id → paragraph position)
	const strokes: Stroke[] = [];
	for (const { parentId, stroke } of lineItems) {
		const treeOffset = computeOffsetForNode(parentId, entryByTreeId, treeNodeMap);

		// Compute text-anchor Y offset: walk up the tree to find the first
		// node with an anchor_id linking to a text character position.
		let anchorY = 0;
		if (textBlock && charPositions) {
			let walkKey = crdtKey(parentId);
			const walked = new Set<string>();
			while (walkKey && walkKey !== "0:0" && !walked.has(walkKey)) {
				walked.add(walkKey);
				const nd = treeNodeMap.get(walkKey);
				if (nd?.anchorId) {
					const charOff = charPositions.get(crdtKey(nd.anchorId));
					if (charOff !== undefined) {
						anchorY = computeAnchorYOffset(textBlock, charOff);
					}
					break;
				}
				const entry = entryByTreeId.get(walkKey);
				if (!entry) break;
				walkKey = crdtKey(entry.parentId);
			}
		}

		const totalX = treeOffset.x;
		const totalY = treeOffset.y + anchorY;
		if (totalX !== 0 || totalY !== 0) {
			for (const pt of stroke.points) {
				pt.x += totalX;
				pt.y += totalY;
			}
		}
		strokes.push(stroke);
	}

	if (debug) {
		console.log(`  Total blocks: ${blockCount}, strokes: ${strokes.length}, tree entries: ${sceneTreeEntries.length}, tree nodes: ${treeNodeMap.size}`);
		if (textBlock) {
			console.log(`  Text block: ${textBlock.text.length} chars at (${textBlock.posX}, ${textBlock.posY})`);
		}
	}

	const layers: Layer[] = strokes.length > 0
		? [{ name: "", strokes }]
		: [];

	return {
		pageId: "",
		layers,
		textSpans: [],
		textBlocks: textBlock ? [textBlock] : [],
		width: 1404,
		height: 1872,
	};
}

// --- LineItem block parsing ---

interface LineItemResult {
	parentId: CrdtId;
	stroke: Stroke;
}

function parseLineItemBlock(reader: BinaryReader, debug: boolean): LineItemResult | null {
	let parentId: CrdtId = [0, 0];
	let deletedLength = 0;

	while (reader.remaining() > 0) {
		const tag = readTag(reader);

		if (tag.index === 1 && tag.type === TAG_ID) {
			// parent_id: which tree node (group) this line belongs to
			parentId = readCrdtId(reader);
		} else if (tag.index >= 2 && tag.index <= 4 && tag.type === TAG_ID) {
			// item_id, left_id, right_id — skip
			reader.skip(1);
			reader.readVarint();
		} else if (tag.index === 5 && tag.type === TAG_BYTE4) {
			deletedLength = reader.readU32();
		} else if (tag.index === 6 && tag.type === TAG_LENGTH4) {
			const subLen = reader.readU32();
			if (deletedLength > 0) {
				return null; // Deleted item
			}
			const subReader = reader.slice(reader.tell(), subLen);
			const stroke = parseLineValue(subReader, debug);
			if (stroke) return { parentId, stroke };
			return null;
		} else {
			skipTagValue(reader, tag);
		}
	}

	return null;
}

function parseLineValue(reader: BinaryReader, debug: boolean): Stroke | null {
	// First byte: item_type (raw, not tagged)
	const itemType = reader.readU8();
	if (itemType !== ITEM_LINE) {
		return null;
	}

	const stroke: Stroke = {
		penType: 0,
		color: 0,
		colorArgb: null,
		thicknessScale: 1.0,
		points: [],
	};

	while (reader.remaining() > 0) {
		const tag = readTag(reader);

		if (tag.index === 1 && tag.type === TAG_BYTE4) {
			stroke.penType = reader.readU32();
		} else if (tag.index === 2 && tag.type === TAG_BYTE4) {
			stroke.color = reader.readU32();
		} else if (tag.index === 3 && tag.type === TAG_BYTE8) {
			stroke.thicknessScale = reader.readF64();
		} else if (tag.index === 4 && tag.type === TAG_BYTE4) {
			reader.readU32(); // starting_length
		} else if (tag.index === 5 && tag.type === TAG_LENGTH4) {
			const pointsLen = reader.readU32();
			const pointsReader = reader.slice(reader.tell(), pointsLen);
			stroke.points = parsePointsV2(pointsReader);
			reader.skip(pointsLen);
		} else if (tag.index === 8 && tag.type === TAG_BYTE4) {
			stroke.colorArgb = reader.readU32();
		} else if (tag.type === TAG_ID) {
			// timestamp or move_id — skip
			reader.skip(1);
			reader.readVarint();
		} else {
			skipTagValue(reader, tag);
		}
	}

	return stroke;
}

// --- Point parsing ---

function parsePointsV2(reader: BinaryReader): Point[] {
	// v2 format: 14 bytes per point
	// x(f32) + y(f32) + speed(u16) + width(u16) + direction(u8) + pressure(u8)
	const points: Point[] = [];

	while (reader.remaining() >= 14) {
		points.push({
			x: reader.readF32(),
			y: reader.readF32(),
			speed: reader.readU16(),
			width: reader.readU16(),
			direction: reader.readU8(),
			pressure: reader.readU8(),
		});
	}

	return points;
}
