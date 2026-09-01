/**
 * Language-aware utilities for translation prompts.
 *
 * Provides SFX examples and colloquial pattern descriptions
 * parameterized by source/target language.
 */

import { getLanguagePromptName } from '$lib/settings/settings.js';

/**
 * Get a language-appropriate SFX translation example for prompts.
 */
export function getSfxExample(sourceLanguage: string): string {
	switch (sourceLanguage) {
		case 'ja':
			return 'ドキドキ → *ba-dump ba-dump*';
		case 'ko':
			return '두근두근 → *ba-dump ba-dump*';
		case 'zh-Hans':
		case 'zh-Hant':
			return '砰砰 → *thump thump*';
		case 'es':
			return 'PUM PUM → *thump thump*';
		case 'fr':
			return 'BOUM BOUM → *boom boom*';
		case 'de':
			return 'BUMM BUMM → *boom boom*';
		case 'pt':
			return 'TUM TUM → *thump thump*';
		case 'it':
			return 'BAM BAM → *bang bang*';
		case 'ru':
			return 'БУМ БУМ → *boom boom*';
		case 'th':
			return 'ตูม ตูม → *boom boom*';
		case 'ar':
			return 'طق طق → *knock knock*';
		case 'hi':
			return 'धड़क धड़क → *ba-dump ba-dump*';
		case 'tr':
			return 'GÜM GÜM → *boom boom*';
		default:
			return '*sound effect* → *descriptive translation*';
	}
}

/**
 * Get a language-aware instruction for handling colloquial patterns.
 */
export function getColloquialInstruction(sourceLanguage: string): string {
	if (sourceLanguage === 'auto') {
		return 'Colloquial language patterns — slang, dialect, idiomatic expressions, formality levels handled correctly?';
	}
	const label = getLanguagePromptName(sourceLanguage);
	switch (sourceLanguage) {
		case 'ja':
			return `Colloquial ${label} patterns — slang, dialect, honorifics handled correctly?`;
		case 'ko':
			return `Colloquial ${label} patterns — slang, speech levels, honorifics handled correctly?`;
		case 'zh-Hans':
		case 'zh-Hant':
			return `Colloquial ${label} patterns — slang, regional expressions, formality levels handled correctly?`;
		default:
			return `Colloquial ${label} patterns — slang, idiomatic expressions, formality levels handled correctly?`;
	}
}
