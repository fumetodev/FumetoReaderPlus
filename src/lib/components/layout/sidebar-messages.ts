import type {
	ReaderPageTranslationPhase,
	ReaderPageTranslationProgress
} from '$lib/translation/reader-page-translation-controller.js';
import type { UserMessage } from '$lib/i18n/user-messages.js';

/** Why a page has no translation to show — a message code, rendered by the sidebar. */
export function getNoTextMessage(model: string): UserMessage {
	if (model === 'on-device-no-regions') return { code: 'reader_status_no_regions' };
	if (model === 'on-device-no-ocr') return { code: 'reader_status_no_ocr' };
	return { code: 'reader_status_no_text' };
}

/** The sidebar's one-line status for a page-translation phase. */
export function getPageTranslationStatusMessage(
	phase: ReaderPageTranslationPhase,
	progress: ReaderPageTranslationProgress | null,
	ocrProvider: 'ppocr'
): UserMessage {
	switch (phase) {
		case 'acquiring-page':
			return { code: 'reader_status_acquiring' };
		case 'detecting':
			return { code: 'reader_status_detecting', params: { engine: ocrProvider === 'ppocr' ? 'PP-OCRv6' : ocrProvider } };
		case 'translating':
			return progress && progress.total > 0
				? { code: 'reader_status_translating_progress', params: { completed: progress.completed, total: progress.total } }
				: { code: 'reader_status_translating' };
		case 'repairing':
			return { code: 'reader_status_repairing' };
		case 'persisting':
			return { code: 'reader_status_persisting' };
		case 'post-processing':
			return { code: 'reader_status_post_processing' };
		case 'cancelling':
			return { code: 'reader_status_cancelling' };
		case 'completed':
			return { code: 'reader_status_completed' };
		case 'failed':
			return { code: 'reader_status_failed' };
		case 'idle':
			return { code: 'reader_status_idle' };
	}
}
