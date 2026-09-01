/**
 * Character-level BERT tokenizer for manga-ocr's decoder
 * (kha-white/manga-ocr-base — bert-base-japanese-char-v2 vocabulary).
 *
 * Only decoding is needed at inference time (the decoder is fed token ids it
 * produced itself), but `encode` exists for tests and future scoring use.
 * `##`-prefixed entries are continuation characters; specials are dropped on
 * decode and spaces removed, matching the upstream `manga_ocr` post-process.
 */

export class MangaOcrTokenizer {
	private readonly idToToken: string[];
	private readonly tokenToId: Map<string, number>;
	readonly padId: number;
	readonly unkId: number;
	readonly clsId: number;
	readonly sepId: number;

	constructor(vocabLines: string[]) {
		this.idToToken = vocabLines;
		this.tokenToId = new Map(vocabLines.map((token, id) => [token, id]));
		this.padId = this.requiredId('[PAD]');
		this.unkId = this.requiredId('[UNK]');
		this.clsId = this.requiredId('[CLS]');
		this.sepId = this.requiredId('[SEP]');
	}

	static fromVocabText(text: string): MangaOcrTokenizer {
		// vocab.txt is one token per line; keep empty non-terminal lines intact
		// so ids stay aligned, only trimming the trailing newline artifact.
		const lines = text.split('\n');
		if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
		return new MangaOcrTokenizer(lines.map((line) => line.replace(/\r$/, '')));
	}

	private requiredId(token: string): number {
		const id = this.tokenToId.get(token);
		if (id === undefined) throw new Error(`manga-ocr vocab is missing ${token}`);
		return id;
	}

	get vocabSize(): number {
		return this.idToToken.length;
	}

	isSpecial(id: number): boolean {
		const token = this.idToToken[id];
		return token !== undefined && token.startsWith('[') && token.endsWith(']');
	}

	/** Character-level encode (tests/scoring): unknown chars → [UNK]. */
	encode(text: string): number[] {
		const ids: number[] = [];
		let first = true;
		for (const char of text) {
			if (/\s/u.test(char)) continue;
			const plain = this.tokenToId.get(char);
			const continuation = this.tokenToId.get(`##${char}`);
			ids.push((first ? plain ?? continuation : continuation ?? plain) ?? this.unkId);
			first = false;
		}
		return ids;
	}

	/** Decode ids → text: drop specials, strip `##`, remove spaces. */
	decode(ids: readonly number[]): string {
		let out = '';
		for (const id of ids) {
			if (this.isSpecial(id)) continue;
			const token = this.idToToken[id];
			if (token === undefined) continue;
			out += token.startsWith('##') ? token.slice(2) : token;
		}
		return out.replace(/\s+/gu, '');
	}
}
