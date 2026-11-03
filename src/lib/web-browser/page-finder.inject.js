// @ts-nocheck — a script for other sites' pages, shipped as text (`?raw`); it is never part of the app's own code.
// The page finder. Injected by the in-app browser into every page, before the page's own scripts, and run in the top
// frame only. It knows nothing about any site: it looks at what the page shows and reports the comic pages it finds,
// in reading order, to the app through the `__fumetoFinder` message port. It never changes the page.
//
// Report: {t:'finder', kind, pages:[{u, w, h}], pager, at}
//   kind  'gallery'   two or more page images in one column or row
//         'single'    one page image (a viewer that shows a page at a time, or a one-page comic)
//         'protected' the pages are drawn by the site's own code (canvas or blob: images) and cannot be read
//         'none'      nothing that looks like a comic page
//   pager true when the page has a page-number picker, i.e. a viewer that pages through a chapter
// Link taps are reported as {t:'link', href, from}, so the app can retrace how a chapter was reached.
(() => {
	if (window.top !== window || window.__fumetoFinderInstalled) return;
	window.__fumetoFinderInstalled = true;
	const port = window.__fumetoFinder;
	if (!port || typeof port.postMessage !== 'function') return;
	const post = (message) => {
		try {
			port.postMessage(JSON.stringify(message));
		} catch {
			// The port is gone (page unloading); nothing to report to.
		}
	};

	const LAZY_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'data-lazy', 'data-echo'];
	const MAX_PAGES = 500;

	// Two levels of ancestors without position indexes, with numbers folded away: a reader's pages share it even when
	// each sits in its own wrapper (`page-1`, `page-2`…).
	const containerKey = (el) => {
		const parts = [];
		let node = el.parentElement;
		for (let i = 0; i < 3 && node && node !== document.body; i++, node = node.parentElement) {
			const cls = node.classList.length ? '.' + Array.from(node.classList).slice(0, 2).join('.') : '';
			parts.push((node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + cls).replace(/\d+/g, 'N'));
		}
		return parts.reverse().join('>');
	};

	const absolute = (value) => {
		try {
			return new URL(value, location.href).href;
		} catch {
			return '';
		}
	};

	const imageUrl = (img) => {
		let src = img.currentSrc || img.src || '';
		// A lazy loader's placeholder: the real address waits in a data attribute until the image scrolls into view.
		if (!src || src.startsWith('data:') || /blank|placeholder|loading|loader|spinner|spacer/i.test(src)) {
			for (const attr of LAZY_ATTRS) {
				const v = img.getAttribute(attr);
				if (v) return absolute(v.trim().split(/\s+/)[0]);
			}
		}
		return src;
	};

	const collect = () => {
		const vw = window.innerWidth || document.documentElement.clientWidth || 1;
		const items = [];
		for (const img of document.querySelectorAll('img')) {
			const r = img.getBoundingClientRect();
			items.push({
				kind: 'img', src: imageUrl(img), nw: img.naturalWidth, nh: img.naturalHeight,
				w: r.width, h: r.height, top: r.top + window.scrollY, left: r.left + window.scrollX, key: containerKey(img),
			});
		}
		for (const c of document.querySelectorAll('canvas')) {
			const r = c.getBoundingClientRect();
			items.push({
				kind: 'canvas', src: '', nw: c.width, nh: c.height,
				w: r.width, h: r.height, top: r.top + window.scrollY, left: r.left + window.scrollX, key: containerKey(c),
			});
		}
		return { vw, items };
	};

	const isPageSized = (it, vw) =>
		((it.nw >= 500 && it.nh >= 500) || (it.w >= vw * 0.6 && it.h >= vw * 0.6)) &&
		!/\.svg(\?|#|$)|^data:image\/(svg|gif)/i.test(it.src);

	const pick = ({ vw, items }) => {
		const groups = new Map();
		for (const it of items) {
			if (!isPageSized(it, vw)) continue;
			const g = groups.get(it.key);
			if (g) g.push(it);
			else groups.set(it.key, [it]);
		}
		let best = null;
		let bestArea = 0;
		for (const g of groups.values()) {
			const area = g.reduce((s, it) => s + Math.max(it.w * it.h, 1), 0);
			if (area > bestArea) {
				best = g;
				bestArea = area;
			}
		}
		return best || [];
	};

	// A page-number picker: a select whose options are mostly "3", "Page 3", "3 / 14"…
	const hasPager = () => {
		for (const s of document.querySelectorAll('select')) {
			const opts = Array.from(s.options);
			if (opts.length < 3) continue;
			const numeric = opts.filter((o) => /^\D{0,12}\d{1,4}(\s*\/\s*\d{1,4})?\D{0,6}$/.test(o.textContent.trim())).length;
			if (numeric / opts.length >= 0.8 && opts.some((o) => /page|ページ|頁|\//i.test(o.textContent))) return true;
		}
		return false;
	};

	// Images still loading: a page counts only once its image has, so a gallery grows as they arrive. Lazy ones wait
	// to be scrolled to and are not counted.
	const loadingImages = () => {
		let n = 0;
		for (const img of document.querySelectorAll('img')) if (!img.complete && img.loading !== 'lazy') n++;
		return n;
	};

	const find = () => {
		const snapshot = collect();
		const group = pick(snapshot);
		const drawn = group.filter((it) => it.kind === 'canvas' || it.src.startsWith('blob:')).length;
		if (group.length && drawn * 2 >= group.length) return { kind: 'protected', pages: [], pager: hasPager() };
		const pages = [];
		const seen = new Set();
		for (const it of group) {
			if (!/^https?:/i.test(it.src) || seen.has(it.src)) continue;
			seen.add(it.src);
			pages.push({ u: it.src, w: it.nw, h: it.nh });
			if (pages.length >= MAX_PAGES) break;
		}
		// One image is a comic page only when the viewer gives it the column: an article's photo is not a page.
		const lone = pages.length === 1 && group.some((it) => it.src === pages[0].u && it.w >= snapshot.vw * 0.85);
		const kind = pages.length >= 2 ? 'gallery' : lone ? 'single' : 'none';
		return { kind, pages: kind === 'none' ? [] : pages, pager: hasPager(), loading: loadingImages() };
	};

	let timer = 0;
	let last = '';
	const scan = () => {
		timer = 0;
		let report;
		try {
			report = find();
		} catch {
			return;
		}
		const key = JSON.stringify(report);
		if (key === last) return;
		last = key;
		post({ t: 'finder', ...report, at: location.href });
	};
	const schedule = () => {
		if (!timer) timer = setTimeout(scan, 400);
	};

	document.addEventListener(
		'click',
		(event) => {
			const target = event.target;
			const a = target && target.closest ? target.closest('a[href]') : null;
			if (a && /^https?:/i.test(a.href)) post({ t: 'link', href: a.href, from: location.href });
		},
		true,
	);

	const start = () => {
		new MutationObserver(schedule).observe(document.documentElement, {
			subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcset', 'class', 'style', ...LAZY_ATTRS],
		});
		document.addEventListener('load', schedule, true);
		window.addEventListener('scroll', schedule, { passive: true });
		window.addEventListener('resize', schedule);
		// Single-page apps change pages without navigating.
		window.addEventListener('popstate', schedule);
		schedule();
	};
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
	else start();
})();
