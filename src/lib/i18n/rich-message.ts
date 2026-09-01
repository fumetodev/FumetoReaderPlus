/**
 * A tiny, closed markup vocabulary for prose messages.
 *
 * Help paragraphs carry emphasis, code and links. Splitting a sentence into
 * per-span keys translates badly; `{@html}` from a translated string is a
 * risk we do not take. So a message may contain `<em>`, `<code>`, `<br/>`
 * and `<link name="x">…</link>`, and `RichMessage.svelte` renders those as
 * real elements. Anything else — an unknown tag, an unbalanced one — is
 * rendered as literal text, so a broken draft degrades to visible markup
 * instead of vanishing or executing.
 */
export type RichNode =
	| { kind: 'text'; text: string }
	| { kind: 'em' | 'code'; children: RichNode[] }
	| { kind: 'br' }
	| { kind: 'link'; name: string; children: RichNode[] };

const TAG = /<(\/?)(em|code|link|br)(?:\s+name="([a-zA-Z0-9_-]+)")?\s*(\/?)>/g;

export function parseRichMessage(text: string): RichNode[] {
	const root: RichNode[] = [];
	const stack: Array<{ kind: 'em' | 'code' | 'link'; name?: string; children: RichNode[]; open: string }> = [];
	let cursor = 0;
	const emit = (node: RichNode) => (stack.length ? stack[stack.length - 1].children : root).push(node);
	const emitText = (value: string) => {
		if (value) emit({ kind: 'text', text: value });
	};
	for (const match of text.matchAll(TAG)) {
		const [raw, closing, tag, name, selfClosing] = match;
		emitText(text.slice(cursor, match.index));
		cursor = (match.index ?? 0) + raw.length;
		if (tag === 'br') {
			if (closing) emitText(raw);
			else emit({ kind: 'br' });
			continue;
		}
		if (selfClosing) {
			emitText(raw);
			continue;
		}
		if (!closing) {
			if (tag === 'link' && !name) {
				emitText(raw);
				continue;
			}
			stack.push({ kind: tag as 'em' | 'code' | 'link', name, children: [], open: raw });
			continue;
		}
		const top = stack[stack.length - 1];
		if (!top || top.kind !== tag) {
			emitText(raw);
			continue;
		}
		stack.pop();
		const node: RichNode =
			top.kind === 'link' ? { kind: 'link', name: top.name!, children: top.children } : { kind: top.kind, children: top.children };
		emit(node);
	}
	emitText(text.slice(cursor));
	// Unclosed tags: flatten back into literal text, in order.
	while (stack.length) {
		const open = stack.pop()!;
		const parent = stack.length ? stack[stack.length - 1].children : root;
		parent.push({ kind: 'text', text: open.open }, ...open.children);
	}
	return root;
}

/** The plain text of a message, tags stripped — for titles, aria and tests. */
export function richMessageText(nodes: RichNode[]): string {
	return nodes
		.map((node) => {
			switch (node.kind) {
				case 'text':
					return node.text;
				case 'br':
					return '\n';
				default:
					return richMessageText(node.children);
			}
		})
		.join('');
}
