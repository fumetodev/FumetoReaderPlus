import { db } from '$lib/db/index.js';
import { settings, type FumetoSettings } from '$lib/settings/settings.js';
import type {
	ComicTab,
	DetectedTextRegion,
	OverlayEntry,
	PageDimensions,
	PageTranslation,
	PageTranslationEntryDraft,
	RemoteFolder,
	VolumePageRecord,
	VolumeMetadata,
} from '$lib/types/index.js';
import {
	bulkPutVolumes,
	folderCoverAssetId,
	makeMediaAsset,
	tabPreviewAssetId,
	volumeThumbnailAssetId,
} from '$lib/catalog/catalog-repository.js';
import { appWorkCoordinator } from '$lib/work-coordination/work-coordinator.js';
import { bulkPutTabs } from '$lib/tabs/comic-tabs.js';
import { catalogController } from '$lib/controllers/catalog-controller.js';
import { tabsController } from '$lib/controllers/tabs-controller.js';
import { get } from 'svelte/store';
import {
	catalogSearchQuery,
	currentRemoteFolderId,
	currentSubfolder,
	selectedLibraryId,
} from '$lib/stores/catalog-state.js';
import { appView, currentPageIndex, currentVolume, openReader, readerReturnView } from '$lib/stores/reader-state.js';
import { readerPageTranslationController } from '$lib/translation/reader-page-translation-runtime.js';
import { createOverlayDocumentV2, pageOverlayRepository } from '$lib/overlay-layout/index.js';

const PREFIX = '__fumeto_ui_fixture__:';
const LIBRARY_ID = `${PREFIX}library`;
const YAC_LIBRARY_ID = `${PREFIX}yac-library`;
const PNG_BYTES = new Uint8Array([
	137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
	0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0, 0, 181, 28, 12, 2,
	0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 100, 248, 15, 0, 1,
	5, 1, 1, 39, 24, 227, 102, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130
]);
let controllersPausedForSeed = false;

export interface MobileUiFixtureHost {
	seedCatalog(count?: number): Promise<{ count: number; libraryId: string }>;
	seedYacThumbnailCatalog(folderCount?: number, volumeCount?: number): Promise<{
		folderCount: number;
		volumeCount: number;
		libraryId: string;
	}>;
	beginCatalogSeed(): Promise<void>;
	seedCatalogChunk(start: number, count: number): Promise<{ start: number; count: number }>;
	finishCatalogSeed(count: number): Promise<{ count: number; libraryId: string }>;
	seedTabs(count?: number): Promise<{ count: number }>;
	prepareReader(volumeUuid: string): Promise<void>;
	seedOverlay(volumeUuid: string, pageIndex?: number): Promise<void>;
	seedOverlayQualitySuite(volumeUuid: string): Promise<{ cases: OverlayQualityFixtureCase[] }>;
	inspectOverlayQualityRecord(volumeUuid: string, pageIndex: number): Promise<{
		pageTranslationId: string;
		model?: string;
		promptTokens?: number;
		completionTokens?: number;
		documentRevision: number;
		writingModes: Array<string | null>;
	}>;
	openFixtureReader(volumeUuid: string, pageIndex?: number): Promise<void>;
	snapshotNavigation(): {
		appView: 'catalog' | 'reader' | 'settings' | 'tabs';
		currentVolume: VolumeMetadata | null;
		currentPageIndex: number;
		readerReturnView: 'catalog' | 'tabs';
		selectedLibraryId: string | null;
		currentSubfolder: string;
		currentRemoteFolderId: string | null;
		catalogSearchQuery: string;
	};
	restoreNavigation(snapshot: ReturnType<MobileUiFixtureHost['snapshotNavigation']>): void;
	inspectReaderTranslation(): ReturnType<typeof readerPageTranslationController.inspect>;
	hymt2Translate(text: string): Promise<{ variant: string; path: string; out: string }>;
	snapshotSettings(): FumetoSettings;
	prepareReaderEvidenceSettings(): void;
	restoreSettings(snapshot: FumetoSettings): void;
	clean(): Promise<void>;
	holdCatalogLane(durationMs?: number): Promise<{ taskId: string }>;
	inspect(): Promise<{
		volumes: number;
		tabs: number;
		catalogRows: number;
		mediaAssets: number;
		activeTranslationJobs: number;
		work: ReturnType<typeof appWorkCoordinator.inspect>;
		longTasks: number;
	}>;
}

export interface OverlayQualityFixtureCase {
	id: 'english-horizontal' | 'japanese-vertical' | 'adjacent-balloons' | 'reveal-tap' | 'arabic-rtl' | 'sfx-suppression';
	pageIndex: number;
	locale: string;
	baseDirection: 'ltr' | 'rtl' | 'auto';
	expectedTexts: string[];
	verticalText?: string;
}

interface OverlayQualityFixtureDefinition extends OverlayQualityFixtureCase {
	regions: DetectedTextRegion[];
	overlays: OverlayEntry[];
	translations: PageTranslationEntryDraft[];
}

const speechContour = (left: number, top: number, right: number, bottom: number): [number, number][] => {
	const insetX = (right - left) * 0.12;
	const insetY = (bottom - top) * 0.14;
	return [
		[left + insetX, top],
		[right - insetX, top],
		[right, top + insetY],
		[right, bottom - insetY],
		[right - insetX, bottom],
		[left + insetX, bottom],
		[left, bottom - insetY],
		[left, top + insetY],
	];
};

// The reveal fixture passage must stay unfittable at the last-resort floor
// (2px@1200 packs roughly six times more text than the previous 5px), so the
// base sentence gains filler far beyond the balloon's capacity at any size.
const REVEAL_TAP_TRANSLATION = [
	'This translation is intentionally far, far too long to fit inside such a tiny speech balloon at any legible size whatsoever, no matter how aggressively the placement engine shrinks whitespace, drops the font toward its absolute minimum, or rearranges line breaks; the only correct outcome for a passage of this length in a balloon this small is the tap-to-reveal placement path, which whitewashes the balloon, tints it, and shows this text in a popover when the reader taps it.',
	...Array.from({ length: 12 }, (_, index) => `No matter how many times this filler sentence repeats (${index + 1} of 12), it exists only to keep the passage larger than the balloon can hold at the two-pixel absolute floor.`)
].join(' ');

const OVERLAY_QUALITY_CASES: OverlayQualityFixtureDefinition[] = [
	{
		id: 'english-horizontal',
		pageIndex: 0,
		locale: 'en',
		baseDirection: 'ltr',
		expectedTexts: [
			'The station closes in fifteen minutes. We should hurry.',
			'Later that evening, rain covered the quiet city.',
		],
		regions: [
			{
				boxId: 101, x: 255, y: 230, width: 220, height: 70, confidence: 1,
				polygon: [[255, 230], [475, 230], [475, 300], [255, 300]],
				orientationDegrees: 0, writingMode: 'horizontal-tb', groupKind: 'speech',
				bubbleId: 11, bubbleOverlap: 1, inBubble: true,
				contour: speechContour(85, 105, 715, 475),
			},
			{
				boxId: 102, x: 145, y: 790, width: 430, height: 75, confidence: 1,
				polygon: [[145, 790], [575, 790], [575, 865], [145, 865]],
				orientationDegrees: 0, writingMode: 'horizontal-tb', groupKind: 'narration',
				panelId: 'quality-panel-english', inBubble: false,
			},
		],
		overlays: [
			{
				boxId: 101, original_text: 'fixture english speech',
				translated_text: 'The station closes in fifteen minutes. We should hurry.',
				type: 'speech', x: 255, y: 230, width: 220, height: 70, inBubble: true,
				contour: speechContour(85, 105, 715, 475),
			},
			{
				boxId: 102, original_text: 'fixture english narration',
				translated_text: 'Later that evening, rain covered the quiet city.',
				type: 'narration', x: 145, y: 790, width: 430, height: 75,
			},
		],
		translations: [
			{ order: 0, boxId: 101, original_text: 'fixture english speech', translated_text: 'The station closes in fifteen minutes. We should hurry.', type: 'speech' },
			{ order: 1, boxId: 102, original_text: 'fixture english narration', translated_text: 'Later that evening, rain covered the quiet city.', type: 'narration' },
		],
	},
	{
		id: 'japanese-vertical',
		pageIndex: 1,
		locale: 'ja',
		baseDirection: 'ltr',
		expectedTexts: ['次の駅で降りましょう', '安全第一'],
		verticalText: '次の駅で降りましょう',
		regions: [
			{
				boxId: 201, x: 535, y: 220, width: 82, height: 300, confidence: 1,
				polygon: [[535, 220], [617, 220], [617, 520], [535, 520]],
				orientationDegrees: -90, writingMode: 'vertical-rl', groupKind: 'speech',
				bubbleId: 21, bubbleOverlap: 1, inBubble: true,
				contour: speechContour(405, 75, 735, 720),
			},
			{
				boxId: 202, x: 105, y: 835, width: 265, height: 95, confidence: 1,
				polygon: [[105, 835], [370, 835], [370, 930], [105, 930]],
				orientationDegrees: 0, writingMode: 'horizontal-tb', groupKind: 'sign',
				panelId: 'quality-panel-japanese', inBubble: false,
			},
		],
		overlays: [
			{
				boxId: 201, original_text: '縦書き', translated_text: '次の駅で降りましょう',
				type: 'speech', x: 535, y: 220, width: 82, height: 300, inBubble: true,
				contour: speechContour(405, 75, 735, 720), customVerticalText: true,
			},
			{
				boxId: 202, original_text: '標識', translated_text: '安全第一',
				type: 'sign', x: 105, y: 835, width: 265, height: 95, customVerticalText: false,
			},
		],
		translations: [
			{ order: 0, boxId: 201, original_text: '縦書き', translated_text: '次の駅で降りましょう', type: 'speech' },
			{ order: 1, boxId: 202, original_text: '標識', translated_text: '安全第一', type: 'sign' },
		],
	},
	{
		// Two tall narrow speech balloons whose contours slightly overlap —
		// a page-adjacency stress case, as a deterministic fixture.
		// Erosion must keep each translation's ink on its own side with zero
		// collision and no drops (place-always).
		id: 'adjacent-balloons',
		pageIndex: 3,
		locale: 'en',
		baseDirection: 'ltr',
		expectedTexts: [
			'Without any symptoms whatsoever, they sent me here anyway.',
			'That is exactly what the team doctor kept insisting on.',
		],
		regions: [
			{
				boxId: 401, x: 350, y: 430, width: 60, height: 320, confidence: 1,
				polygon: [[350, 430], [410, 430], [410, 750], [350, 750]],
				orientationDegrees: 0, writingMode: 'horizontal-tb', groupKind: 'speech',
				bubbleId: 41, bubbleOverlap: 1, inBubble: true,
				contour: speechContour(300, 380, 455, 890),
			},
			{
				boxId: 402, x: 495, y: 430, width: 60, height: 320, confidence: 1,
				polygon: [[495, 430], [555, 430], [555, 750], [495, 750]],
				orientationDegrees: 0, writingMode: 'horizontal-tb', groupKind: 'speech',
				bubbleId: 42, bubbleOverlap: 1, inBubble: true,
				contour: speechContour(445, 380, 610, 880),
			},
		],
		overlays: [
			{
				boxId: 401, original_text: 'fixture adjacent left',
				translated_text: 'Without any symptoms whatsoever, they sent me here anyway.',
				type: 'speech', x: 350, y: 430, width: 60, height: 320, inBubble: true,
				contour: speechContour(300, 380, 455, 890),
			},
			{
				boxId: 402, original_text: 'fixture adjacent right',
				translated_text: 'That is exactly what the team doctor kept insisting on.',
				type: 'speech', x: 495, y: 430, width: 60, height: 320, inBubble: true,
				contour: speechContour(445, 380, 610, 880),
			},
		],
		translations: [
			{ order: 0, boxId: 401, original_text: 'fixture adjacent left', translated_text: 'Without any symptoms whatsoever, they sent me here anyway.', type: 'speech' },
			{ order: 1, boxId: 402, original_text: 'fixture adjacent right', translated_text: 'That is exactly what the team doctor kept insisting on.', type: 'speech' },
		],
	},
	{
		// A deliberately impossible fit: tiny balloon, very long translation.
		// Must produce a tap-to-reveal placement whose single-tap popover the
		// physical spec exercises end-to-end.
		id: 'reveal-tap',
		pageIndex: 4,
		locale: 'en',
		baseDirection: 'ltr',
		expectedTexts: [
			REVEAL_TAP_TRANSLATION,
		],
		regions: [
			{
				boxId: 501, x: 360, y: 520, width: 40, height: 30, confidence: 1,
				polygon: [[360, 520], [400, 520], [400, 550], [360, 550]],
				orientationDegrees: 0, writingMode: 'horizontal-tb', groupKind: 'speech',
				bubbleId: 51, bubbleOverlap: 1, inBubble: true,
				contour: speechContour(345, 505, 415, 565),
			},
		],
		overlays: [
			{
				boxId: 501, original_text: 'fixture reveal',
				translated_text: REVEAL_TAP_TRANSLATION,
				type: 'speech', x: 360, y: 520, width: 40, height: 30, inBubble: true,
				contour: speechContour(345, 505, 415, 565),
			},
		],
		translations: [
			{ order: 0, boxId: 501, original_text: 'fixture reveal', translated_text: REVEAL_TAP_TRANSLATION, type: 'speech' },
		],
	},
	{
		id: 'arabic-rtl',
		pageIndex: 2,
		locale: 'ar',
		baseDirection: 'rtl',
		expectedTexts: [
			'سنصل إلى المحطة بعد قليل، فلا تقلق.',
			'كان المساء هادئًا والمدينة مضيئة.',
		],
		regions: [
			{
				boxId: 301, x: 220, y: 245, width: 360, height: 85, confidence: 1,
				polygon: [[220, 245], [580, 245], [580, 330], [220, 330]],
				orientationDegrees: 0, writingMode: 'horizontal-tb', groupKind: 'speech',
				bubbleId: 31, bubbleOverlap: 1, inBubble: true,
				contour: speechContour(70, 100, 730, 505),
			},
			{
				boxId: 302, x: 170, y: 805, width: 470, height: 85, confidence: 1,
				polygon: [[170, 805], [640, 805], [640, 890], [170, 890]],
				orientationDegrees: 0, writingMode: 'horizontal-tb', groupKind: 'narration',
				panelId: 'quality-panel-arabic', inBubble: false,
			},
		],
		overlays: [
			{
				boxId: 301, original_text: 'fixture arabic speech',
				translated_text: 'سنصل إلى المحطة بعد قليل، فلا تقلق.',
				type: 'speech', x: 220, y: 245, width: 360, height: 85, inBubble: true,
				contour: speechContour(70, 100, 730, 505),
			},
			{
				boxId: 302, original_text: 'fixture arabic narration',
				translated_text: 'كان المساء هادئًا والمدينة مضيئة.',
				type: 'narration', x: 170, y: 805, width: 470, height: 85,
			},
		],
		translations: [
			{ order: 0, boxId: 301, original_text: 'fixture arabic speech', translated_text: 'سنصل إلى المحطة بعد قليل، فلا تقلق.', type: 'speech' },
			{ order: 1, boxId: 302, original_text: 'fixture arabic narration', translated_text: 'كان المساء هادئًا والمدينة مضيئة.', type: 'narration' },
		],
	},
	{
		// Policy-22 SFX gate: one balloon control plus the three free-SFX arms —
		// LLM 'sfx' label under a defeated classifier, asterisk-only translation
		// under a 'sign' misclassification, and label-free mimetic katakana.
		// Evidence settings run with overlaySfx ON, so all four texts render for
		// the quality suite; toggling the setting off must leave only the balloon.
		id: 'sfx-suppression',
		pageIndex: 5,
		locale: 'ja',
		baseDirection: 'ltr',
		expectedTexts: ['What is that sound?', 'KRAKOOM!', '*flump*', 'RUMBLE', 'The storm reached the harbor that night.'],
		regions: [
			{
				boxId: 601, x: 255, y: 230, width: 220, height: 70, confidence: 1,
				polygon: [[255, 230], [475, 230], [475, 300], [255, 300]],
				orientationDegrees: 0, writingMode: 'horizontal-tb', groupKind: 'speech',
				bubbleId: 61, bubbleOverlap: 1, inBubble: true,
				contour: speechContour(85, 105, 715, 475),
			},
			{
				boxId: 602, x: 120, y: 560, width: 320, height: 130, confidence: 1,
				polygon: [[120, 560], [440, 560], [440, 690], [120, 690]],
				orientationDegrees: 0, writingMode: 'horizontal-tb', groupKind: 'unknown',
				inBubble: false,
			},
			{
				boxId: 603, x: 480, y: 760, width: 220, height: 90, confidence: 1,
				polygon: [[480, 760], [700, 760], [700, 850], [480, 850]],
				orientationDegrees: 0, writingMode: 'horizontal-tb', groupKind: 'sign',
				inBubble: false,
			},
			{
				boxId: 604, x: 120, y: 950, width: 360, height: 120, confidence: 1,
				polygon: [[120, 950], [480, 950], [480, 1070], [120, 1070]],
				orientationDegrees: 0, writingMode: 'horizontal-tb', groupKind: 'borderless',
				inBubble: false,
			},
			{
				boxId: 605, x: 520, y: 1080, width: 260, height: 90, confidence: 1,
				polygon: [[520, 1080], [780, 1080], [780, 1170], [520, 1170]],
				orientationDegrees: 0, writingMode: 'horizontal-tb', groupKind: 'narration',
				inBubble: false,
			},
		],
		overlays: [
			{
				boxId: 601, original_text: 'この音は何だ',
				translated_text: 'What is that sound?',
				type: 'speech', x: 255, y: 230, width: 220, height: 70, inBubble: true,
				contour: speechContour(85, 105, 715, 475),
			},
			{
				boxId: 602, original_text: 'ゴゴゴゴ',
				translated_text: 'KRAKOOM!',
				type: 'sfx', x: 120, y: 560, width: 320, height: 130,
			},
			{
				boxId: 603, original_text: 'ぽすっ',
				translated_text: '*flump*', type: 'unknown', x: 480, y: 760, width: 220, height: 90,
			},
			{
				boxId: 604, original_text: 'ドドドド',
				translated_text: 'RUMBLE', type: 'unknown', x: 120, y: 950, width: 360, height: 120,
			},
			{
				boxId: 605, original_text: 'その夜、嵐は港に達した',
				translated_text: 'The storm reached the harbor that night.',
				type: 'narration', x: 520, y: 1080, width: 260, height: 90,
			},
		],
		translations: [
			{ order: 0, boxId: 601, original_text: 'この音は何だ', translated_text: 'What is that sound?', type: 'speech' },
			{ order: 1, boxId: 602, original_text: 'ゴゴゴゴ', translated_text: 'KRAKOOM!', type: 'sfx' },
			{ order: 2, boxId: 603, original_text: 'ぽすっ', translated_text: '*flump*' },
			{ order: 3, boxId: 604, original_text: 'ドドドド', translated_text: 'RUMBLE' },
			{ order: 4, boxId: 605, original_text: 'その夜、嵐は港に達した', translated_text: 'The storm reached the harbor that night.', type: 'narration' },
		],
	},
];

function fixtureVolume(index: number): VolumeMetadata {
	return {
		volume_uuid: `${PREFIX}volume:${index}`,
		title: `Fixture Comic ${String(index + 1).padStart(5, '0')}`,
		filename: `fixture-${index}.cbz`,
		page_count: 12,
		created_at: new Date(1_700_000_000_000 + index).toISOString(),
		current_page: index % 12,
		reading_direction: 'rtl',
		library_id: LIBRARY_ID,
		folder_path: ''
	};
}

function fixtureDimensions(volume: VolumeMetadata): PageDimensions {
	return {
		volume_uuid: volume.volume_uuid,
		pages: Array.from({ length: volume.page_count }, (_, index) => ({
			index, width: 800, height: 1200, filename: `page-${index + 1}.jpg`
		}))
	};
}

/** v17 page rows — fixtures exercise the same storage path production uses. */
function fixturePageRows(volume: VolumeMetadata): VolumePageRecord[] {
	return Array.from({ length: volume.page_count }, (_, index) => {
		const filename = `page-${index + 1}.jpg`;
		return {
			volume_uuid: volume.volume_uuid,
			page_index: index,
			filename,
			file: new File([PNG_BYTES], filename, { type: 'image/png' })
		};
	});
}

function registerFixtureLibrary(): void {
	settings.update((current) => ({
		...current,
		libraries: [
			...current.libraries.filter((library) => library.id !== LIBRARY_ID),
			{ id: LIBRARY_ID, type: 'local', name: 'UI Fixture Library', path: '/debug/fixture', autoScan: false, watchEnabled: false }
		]
	}));
}

function resumeFixtureControllers(): void {
	if (!controllersPausedForSeed) return;
	controllersPausedForSeed = false;
	catalogController.start();
	tabsController.start();
}

export function installMobileUiFixtureHost(target: Window = window): () => void {
	const record = target as unknown as Record<string, unknown>;
	const prior = record.__fumeto_mobile_ui_fixture;
	const host: MobileUiFixtureHost = {
		async seedCatalog(requested = 13_097) {
			const count = Math.max(0, Math.min(20_000, Math.floor(requested)));
			await host.beginCatalogSeed();
			for (let start = 0; start < count; start += 500) {
				await host.seedCatalogChunk(start, Math.min(500, count - start));
			}
			const result = await host.finishCatalogSeed(count);
			resumeFixtureControllers();
			return result;
		},
		async seedYacThumbnailCatalog(requestedFolderCount = 6, requestedVolumeCount = 120) {
			const folderCount = Math.max(1, Math.min(30, Math.floor(requestedFolderCount)));
			const volumeCount = Math.max(1, Math.min(500, Math.floor(requestedVolumeCount)));
			await host.beginCatalogSeed();
			const now = new Date().toISOString();
			const thumbnail = () => new Blob([PNG_BYTES], { type: 'image/png' });
			const volumes: VolumeMetadata[] = Array.from({ length: volumeCount }, (_, index) => ({
				...fixtureVolume(index),
				volume_uuid: `${PREFIX}yac-volume:${index}`,
				title: `YAC Fixture Comic ${String(index + 1).padStart(4, '0')}`,
				library_id: YAC_LIBRARY_ID,
				thumbnail: thumbnail(),
				thumbnail_width: 1,
				thumbnail_height: 1,
				source: {
					type: 'yacreader',
					serverUrl: 'http://127.0.0.1:9',
					remoteLibraryId: 1,
					remoteComicId: String(index + 1),
					comicHash: `fixture-comic-hash-${index + 1}`,
					remoteFolderId: '1',
				},
			}));
			const folders: RemoteFolder[] = Array.from({ length: folderCount }, (_, index) => {
				const id = `${YAC_LIBRARY_ID}:folder-${index + 1}`;
				return {
					id,
					librarySettingsId: YAC_LIBRARY_ID,
					remoteLibraryId: 1,
					remoteFolderId: `folder-${index + 1}`,
					name: `YAC Fixture Folder ${String(index + 1).padStart(3, '0')}`,
					parentFolderId: null,
					parentKey: 'root',
					numChildren: 0,
					coverHash: `fixture-folder-hash-${index + 1}`,
					coverPath: `fixture-folder-hash-${index + 1}.jpg`,
					coverAssetId: folderCoverAssetId(id),
					coverState: 'ready',
					metadataRevision: 1,
					lastFetched: now,
					serverUpdatedAt: now,
				};
			});
			await bulkPutVolumes(volumes);
			await db.transaction('rw', [db.remote_folders, db.media_assets, db.catalog_index_state], async () => {
				await db.remote_folders.bulkPut(folders);
				await db.media_assets.bulkPut(folders.map((folder) => makeMediaAsset({
					id: folder.coverAssetId!,
					ownerType: 'folder',
					ownerId: folder.id,
					kind: 'folder-cover',
					blob: thumbnail(),
					revision: `fixture-folder:${folder.metadataRevision}`,
				})));
				await db.catalog_index_state.put({
					library_id: YAC_LIBRARY_ID,
					provider: 'yacreader',
					completeness: 'ready',
					generation: 1,
					status: 'ready',
					folders_visited: folderCount,
					entries_discovered: folderCount + volumeCount,
					entries_reconciled: volumeCount,
					last_success_at: now,
					updated_at: now,
				});
			});
			settings.update((current) => ({
				...current,
				libraries: [
					...current.libraries.filter((library) => library.id !== YAC_LIBRARY_ID),
					{
						id: YAC_LIBRARY_ID,
						type: 'yacreader',
						name: 'YAC UI Fixture Library',
						serverUrl: 'http://127.0.0.1:9',
						remoteLibraryId: 1,
						remoteLibraryUuid: 'debug-yac-ui-fixture',
						syncMode: 'browse',
					},
				],
			}));
			catalogSearchQuery.set('');
			currentSubfolder.set('');
			currentRemoteFolderId.set(null);
			selectedLibraryId.set(YAC_LIBRARY_ID);
			resumeFixtureControllers();
			return { folderCount, volumeCount, libraryId: YAC_LIBRARY_ID };
		},
		async beginCatalogSeed() {
			await host.clean();
			catalogController.destroy();
			tabsController.destroy();
			controllersPausedForSeed = true;
		},
		async seedCatalogChunk(requestedStart, requestedCount) {
			const start = Math.max(0, Math.min(20_000, Math.floor(requestedStart)));
			const count = Math.max(0, Math.min(500, 20_000 - start, Math.floor(requestedCount)));
			await bulkPutVolumes(Array.from({ length: count }, (_, offset) => fixtureVolume(start + offset)));
			return { start, count };
		},
		async finishCatalogSeed(requestedCount) {
			const count = Math.max(0, Math.min(20_000, Math.floor(requestedCount)));
			const persisted = await db.volumes.where('volume_uuid').startsWith(PREFIX).count();
			if (persisted !== count) {
				throw new Error(`Fixture catalog is incomplete: expected ${count}, found ${persisted}`);
			}
			const now = new Date().toISOString();
			await db.catalog_index_state.put({
				library_id: LIBRARY_ID,
				provider: 'local',
				completeness: 'ready',
				generation: 1,
				status: 'ready',
				folders_visited: 0,
				entries_discovered: count,
				entries_reconciled: count,
				last_success_at: now,
				updated_at: now,
			});
			registerFixtureLibrary();
			return { count, libraryId: LIBRARY_ID };
		},
		async seedTabs(requested = 50) {
			const available = await db.volumes.where('volume_uuid').startsWith(PREFIX).sortBy('volume_uuid');
			const count = Math.min(Math.max(0, Math.floor(requested)), available.length);
			const selected = available.slice(0, count);
			const openedAt = new Date().toISOString();
			const tabs: ComicTab[] = selected.map((volume, position) => ({
				volume_uuid: volume.volume_uuid,
				position,
				opened_at: openedAt,
				last_active_at: openedAt
			}));
			await bulkPutTabs(tabs);
			await db.transaction('rw', [db.volume_pages, db.page_dimensions], async () => {
				await db.volume_pages.bulkPut(selected.flatMap(fixturePageRows));
				await db.page_dimensions.bulkPut(selected.map(fixtureDimensions));
			});
			resumeFixtureControllers();
			return { count };
		},
		async prepareReader(volumeUuid) {
			if (!volumeUuid.startsWith(PREFIX)) throw new Error('Only fixture-owned volumes can receive fixture pages');
			const volume = await db.volumes.get(volumeUuid);
			if (!volume) throw new Error(`Fixture volume does not exist: ${volumeUuid}`);
			await db.transaction('rw', [db.volume_pages, db.page_dimensions], async () => {
				await db.volume_pages.bulkPut(fixturePageRows(volume));
				await db.page_dimensions.put(fixtureDimensions(volume));
			});
		},
		async seedOverlay(volumeUuid, requestedPageIndex = 0) {
			await host.prepareReader(volumeUuid);
			const volume = await db.volumes.get(volumeUuid);
			if (!volume) throw new Error(`Fixture volume does not exist: ${volumeUuid}`);
			const pageIndex = Math.max(0, Math.min(Math.floor(requestedPageIndex), volume.page_count - 1));
			const adapted = createOverlayDocumentV2({
				draft: {
					regions: [{ boxId: 1, x: 120, y: 180, width: 360, height: 160, confidence: 1, inBubble: true }],
					entries: [{ boxId: 1, original_text: 'fixture', translated_text: 'Fixture overlay', type: 'speech', x: 120, y: 180, width: 360, height: 160, inBubble: true }]
				},
				entries: [{ order: 0, original_text: 'fixture', translated_text: 'Fixture overlay', type: 'speech', boxId: 1 }],
				sourceImage: { width: 800, height: 1200, fingerprint: `${PREFIX}page:${volumeUuid}:${pageIndex}` },
				locale: 'en',
				pipeline: 'debug-fixture'
			});
			const record: PageTranslation = {
				id: `${PREFIX}overlay:${volumeUuid}:${pageIndex}`,
				volume_uuid: volumeUuid,
				page_index: pageIndex,
				entries: adapted.entries,
				model: 'debug-fixture',
				prompt_tokens: 0,
				completion_tokens: 0,
				created_at: new Date().toISOString(),
				overlay_data: adapted.document
			};
			await pageOverlayRepository.put(record);
		},
		async seedOverlayQualitySuite(volumeUuid) {
			await host.prepareReader(volumeUuid);
			const volume = await db.volumes.get(volumeUuid);
			if (!volume) throw new Error(`Fixture volume does not exist: ${volumeUuid}`);
			for (const definition of OVERLAY_QUALITY_CASES) {
				if (definition.pageIndex >= volume.page_count) {
					throw new Error(`Fixture volume does not contain quality page ${definition.pageIndex}`);
				}
				const adapted = createOverlayDocumentV2({
					draft: { regions: definition.regions, entries: definition.overlays },
					entries: definition.translations,
					sourceImage: {
						width: 800,
						height: 1200,
						fingerprint: `${PREFIX}quality:${definition.id}`,
					},
					locale: definition.locale,
					baseDirection: definition.baseDirection,
					pipeline: 'debug-device-quality',
				});
				await pageOverlayRepository.put({
					id: `${PREFIX}quality-overlay:${volumeUuid}:${definition.pageIndex}`,
					volume_uuid: volumeUuid,
					page_index: definition.pageIndex,
					entries: adapted.entries,
					model: 'debug-device-quality',
					prompt_tokens: 0,
					completion_tokens: 0,
					created_at: new Date().toISOString(),
					overlay_data: adapted.document,
				});
			}
			return {
				cases: OVERLAY_QUALITY_CASES.map(({ regions: _regions, overlays: _overlays, translations: _translations, ...definition }) => ({
					...definition,
					expectedTexts: [...definition.expectedTexts],
				})),
			};
		},
		async inspectOverlayQualityRecord(volumeUuid, pageIndex) {
			if (!volumeUuid.startsWith(PREFIX)) throw new Error('Only fixture-owned overlays can be inspected');
			const read = await pageOverlayRepository.load(volumeUuid, pageIndex);
			if (read.status !== 'ready' || !read.overlay || !read.pageTranslation) {
				throw new Error('Fixture overlay record is unavailable');
			}
			return {
				pageTranslationId: read.pageTranslation.id,
				model: read.pageTranslation.model,
				promptTokens: read.pageTranslation.prompt_tokens,
				completionTokens: read.pageTranslation.completion_tokens,
				documentRevision: read.overlay.documentRevision,
				writingModes: read.overlay.items.map((item) => item.manual.writingMode ?? null),
			};
		},
		async openFixtureReader(volumeUuid, requestedPageIndex = 0) {
			if (!volumeUuid.startsWith(PREFIX)) throw new Error('Only fixture-owned volumes can be opened by the fixture host');
			await host.prepareReader(volumeUuid);
			const volume = await db.volumes.get(volumeUuid);
			if (!volume || !(await openReader(volume, 'catalog'))) throw new Error(`Unable to open fixture volume: ${volumeUuid}`);
			currentPageIndex.set(Math.max(0, Math.min(Math.floor(requestedPageIndex), volume.page_count - 1)));
		},
		snapshotNavigation() {
			return {
				appView: get(appView),
				currentVolume: get(currentVolume),
				currentPageIndex: get(currentPageIndex),
				readerReturnView: get(readerReturnView),
				selectedLibraryId: get(selectedLibraryId),
				currentSubfolder: get(currentSubfolder),
				currentRemoteFolderId: get(currentRemoteFolderId),
				catalogSearchQuery: get(catalogSearchQuery),
			};
		},
		restoreNavigation(snapshot) {
			selectedLibraryId.set(snapshot.selectedLibraryId);
			currentSubfolder.set(snapshot.currentSubfolder);
			currentRemoteFolderId.set(snapshot.currentRemoteFolderId);
			catalogSearchQuery.set(snapshot.catalogSearchQuery);
			currentVolume.set(snapshot.currentVolume);
			currentPageIndex.set(snapshot.currentPageIndex);
			readerReturnView.set(snapshot.readerReturnView);
			appView.set(snapshot.appView);
		},
		inspectReaderTranslation() {
			return readerPageTranslationController.inspect();
		},
		async hymt2Translate(text: string, targetLang = 'en', sourceLang = 'ja') {
			// Debug-only: proves variant resolution + native load + inference in
			// one call (the exact path production translation takes).
			//
			// Goes through loadActiveHyMT2Model so a custom model is loaded with
			// its prompt format, exactly as production does. The language
			// arguments make the multilingual targets checkable on device —
			// "into zh-Hans" was a shipped prompt bug precisely because nothing
			// exercised a non-English target end to end.
			const [{ getModelPath, activeHyMT2Variant, loadActiveHyMT2Model }, { translateWithHyMT2 }] = await Promise.all([
				import('$lib/translation/gguf-model-manager.js'),
				import('$lib/translation/llamacpp-bridge.js')
			]);
			const variant = activeHyMT2Variant();
			const path = await getModelPath();
			await loadActiveHyMT2Model();
			const out = await translateWithHyMT2(text, sourceLang, targetLang);
			return { variant, path, sourceLang, targetLang, out };
		},
		snapshotSettings() {
			return structuredClone(get(settings));
		},
		prepareReaderEvidenceSettings() {
			settings.update((current) => ({
				...current,
				overlayEnabled: true,
				overlaySfx: true,
				overlayMode: 'bubble-segmentation',
				overlayMinFontSize: 18,
				overlayVerticalText: false,
				variableFontSizing: false,
				readerAutoTranslateOverlays: false,
				resumeLastPage: false,
				showLibraryAccessWarnings: false,
			}));
		},
		restoreSettings(snapshot) {
			settings.set(structuredClone(snapshot));
		},
		async clean() {
			const keys = await db.volumes.where('volume_uuid').startsWith(PREFIX).primaryKeys() as string[];
			const translationKeys = await db.page_translations.where('volume_uuid').startsWith(PREFIX).primaryKeys() as string[];
			const regionKeys = await db.regions.where('volume_uuid').startsWith(PREFIX).primaryKeys() as string[];
			const regionTranslationKeys = await db.translations.where('volume_uuid').startsWith(PREFIX).primaryKeys() as string[];
			const mediaAssetKeys = await db.media_assets.where('owner_id').startsWith(PREFIX).primaryKeys() as string[];
			const remoteFolderKeys = await db.remote_folders.where('id').startsWith(PREFIX).primaryKeys() as string[];
			await db.transaction('rw', [db.volumes, db.volume_files, db.volume_pages, db.page_dimensions, db.comic_tabs, db.page_translations, db.regions, db.translations, db.catalog_rows, db.media_assets, db.remote_folders, db.catalog_index_state], async () => {
				await db.volumes.bulkDelete(keys);
				await db.catalog_rows.bulkDelete(keys);
				await db.media_assets.bulkDelete([
					...mediaAssetKeys,
					...keys.flatMap((key) => [volumeThumbnailAssetId(key), tabPreviewAssetId(key)]),
				]);
				await db.remote_folders.bulkDelete(remoteFolderKeys);
				await db.volume_files.bulkDelete(keys);
				for (const key of keys) {
					await db.volume_pages.where('volume_uuid').equals(key).delete();
				}
				await db.page_dimensions.bulkDelete(keys);
				await db.comic_tabs.bulkDelete(keys);
				await db.page_translations.bulkDelete(translationKeys);
				await db.regions.bulkDelete(regionKeys);
				await db.translations.bulkDelete(regionTranslationKeys);
				await db.catalog_index_state.delete(LIBRARY_ID);
				await db.catalog_index_state.delete(YAC_LIBRARY_ID);
			});
			settings.update((current) => ({
				...current,
				libraries: current.libraries.filter(
					(library) => library.id !== LIBRARY_ID && library.id !== YAC_LIBRARY_ID,
				),
			}));
			selectedLibraryId.set(null);
			currentSubfolder.set('');
			currentRemoteFolderId.set(null);
			catalogSearchQuery.set('');
			resumeFixtureControllers();
		},
		async holdCatalogLane(requestedDuration = 250) {
			const duration = Math.max(0, Math.min(5_000, Math.floor(requestedDuration)));
			const handle = appWorkCoordinator.submit({
				kind: 'debug-catalog-contention', owner: PREFIX, lane: 'catalog-maintenance', priority: 2,
				coalescingKey: `${PREFIX}contention`,
				operation: () => new Promise<void>((resolve) => setTimeout(resolve, duration)),
			});
			void handle.promise.catch(() => {});
			return { taskId: handle.id };
		},
		async inspect() {
			return {
				volumes: await db.volumes.where('volume_uuid').startsWith(PREFIX).count(),
				tabs: await db.comic_tabs.where('volume_uuid').startsWith(PREFIX).count(),
				catalogRows: await db.catalog_rows.where('volume_uuid').startsWith(PREFIX).count(),
				mediaAssets: await db.media_assets.where('owner_id').startsWith(PREFIX).count(),
				activeTranslationJobs: await db.volume_translation_jobs
					.where('volume_uuid').startsWith(PREFIX)
					.filter((job) => job.status === 'translating' || job.status === 'reviewing' || job.status === 'revising')
					.count(),
				work: appWorkCoordinator.inspect(),
				longTasks: typeof performance.getEntriesByType === 'function'
					? performance.getEntriesByType('longtask').length
					: 0,
			};
		}
	};
	record.__fumeto_mobile_ui_fixture = host;
	return () => {
		if (record.__fumeto_mobile_ui_fixture !== host) return;
		if (prior === undefined) delete record.__fumeto_mobile_ui_fixture;
		else record.__fumeto_mobile_ui_fixture = prior;
	};
}
