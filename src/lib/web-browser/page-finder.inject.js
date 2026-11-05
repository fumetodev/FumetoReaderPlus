// @ts-nocheck — a script for other sites' pages, shipped as text (`?raw`); it is never part of the app's own code.
// The page finder. Injected by the in-app browser into every page, before the page's own scripts, and run in the top
// frame only. It knows nothing about any site: it looks at what the page shows and reports the comic pages it finds,
// in reading order, to the app through the `__fumetoFinder` message port. It never changes the page, and it takes the
// port out of the page's reach before any of the page's own scripts run: anything a page could post would be parsed on
// the app's main thread, and a page flooding it filled the Java heap and took the whole app down.
//
// Report: {t:'finder', kind, pages:[{u, w, h}], pager, more, at}
//   kind  'gallery'   two or more images that read as a chapter's pages: upright, wide on the screen, one after another
//         'single'    one page image (a viewer that shows a page at a time, or a one-page comic)
//         'protected' the pages are drawn by the site's own code (canvas or blob: images) and cannot be read
//         'none'      nothing that looks like a comic page
//   pager true when the page has a page-number picker, i.e. a viewer that pages through a chapter
//   more  true when the page has more pages than one report may carry
// Link taps are reported as {t:'link', href, from}, so the app can retrace how a chapter was reached.
(() => {
	const port = window.__fumetoFinder;
	try {
		delete window.__fumetoFinder;
	} catch {
		// Not removable here: the app's side limits what it takes from the port in any case.
	}
	if (window.top !== window || !port || typeof port.postMessage !== 'function') return;
	const post = (message) => {
		try {
			port.postMessage(JSON.stringify(message));
		} catch {
			// The port is gone (page unloading); nothing to report to.
		}
	};

	const LAZY_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'data-lazy', 'data-echo'];
	const MAX_PAGES = 2000;
	// What one report may carry in addresses: the app refuses a bigger message (`RequestPolicy.MAX_MESSAGE_CHARS`).
	const MAX_ADDRESS_CHARS = 2_000_000;

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
				el: img, kind: 'img', src: imageUrl(img), nw: img.naturalWidth, nh: img.naturalHeight,
				w: r.width, h: r.height, top: r.top + window.scrollY, left: r.left + window.scrollX, key: containerKey(img),
			});
		}
		for (const c of document.querySelectorAll('canvas')) {
			const r = c.getBoundingClientRect();
			items.push({
				el: c, kind: 'canvas', src: '', nw: c.width, nh: c.height,
				w: r.width, h: r.height, top: r.top + window.scrollY, left: r.left + window.scrollX, key: containerKey(c),
			});
		}
		return { vw, items };
	};

	const isPageSized = (it, vw) =>
		((it.nw >= 500 && it.nh >= 500) || (it.w >= vw * 0.6 && it.h >= vw * 0.6)) &&
		!/\.svg(\?|#|$)|^data:image\/(svg|gif)/i.test(it.src);

	// The page-sized images of each container, the biggest group first.
	const groupsOf = ({ vw, items }) => {
		const groups = new Map();
		for (const it of items) {
			if (!isPageSized(it, vw)) continue;
			const g = groups.get(it.key);
			if (g) g.push(it);
			else groups.set(it.key, [it]);
		}
		const area = (g) => g.reduce((s, it) => s + Math.max(it.w * it.h, 1), 0);
		return Array.from(groups.values()).sort((a, b) => area(b) - area(a));
	};

	const MIN_PAGE_SHAPE = 1;
	const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1] ?? 0;

	// Height over width as made, not as shown: a card can crop a landscape photo into an upright box.
	const hasOwnSize = (it) => it.nw >= 200 && it.nh >= 200;
	const shapeOf = (it) => (hasOwnSize(it) ? it.nh / it.nw : it.w > 0 ? it.h / it.w : 0);
	// Images still loading are judged by the ones that have: until then a card's box is all there is to go on.
	const standUpright = (group) => {
		const loaded = group.filter(hasOwnSize);
		return median((loaded.length ? loaded : group).map(shapeOf)) >= MIN_PAGE_SHAPE;
	};

	// The text around the images, per image. Measured last, as it asks the page to lay itself out.
	const textPerImage = (group) => {
		let around = group[0].el.parentElement;
		while (around && !group.every((it) => around.contains(it.el))) around = around.parentElement;
		return around ? (around.innerText || '').length / group.length : Infinity;
	};

	// Whether a group of images reads as a chapter's pages rather than a news front page, a shop's shelf or a photo stream
	// (thresholds from 30 ordinary sites against the comic viewers in the finder's test cases). Pages are upright, take
	// most of the screen's width and follow one another with next to nothing between them, or slide past sideways one
	// screen at a time. A viewer may also keep them all in the page and show one, the others not laid out at all.
	const readsAsPages = (group, vw) => {
		const shown = group.filter((it) => it.w > 0 && it.h > 0);
		const upright = standUpright(group);
		if (shown.length < 2) return upright && textPerImage(group) <= 150;
		const width = median(shown.map((it) => it.w));
		const height = median(shown.map((it) => it.h));
		const byTop = [...shown].sort((a, b) => a.top - b.top);
		const gaps = [];
		let besideLast = 0;
		for (let i = 1; i < byTop.length; i++) {
			const above = byTop[i - 1];
			gaps.push(byTop[i].top - (above.top + above.h));
			if (byTop[i].top < above.top + above.h * 0.5) besideLast++;
		}
		const sideways = besideLast / gaps.length;
		if (sideways <= 0.1) {
			if (width < vw * 0.5 || median(gaps) > height * 0.35) return false;
			if (upright) return true;
			// Landscape pages exist. Only a seamless run with nothing else to it reads as them: a photo stream does not.
			const tall = shown.reduce((s, it) => s + it.h, 0) / Math.max(document.documentElement.scrollHeight, 1);
			return tall >= 0.5 && textPerImage(group) <= 30;
		}
		return sideways >= 0.8 && width >= vw * 0.85 && upright && textPerImage(group) <= 150;
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

	// A group's images that can be fetched, each once, as many as a report may carry.
	const pagesOf = (group) => {
		const pages = [];
		const seen = new Set();
		let more = false;
		let chars = 0;
		for (const it of group) {
			if (!/^https?:/i.test(it.src) || seen.has(it.src)) continue;
			seen.add(it.src);
			chars += it.src.length + 40;
			if (pages.length >= MAX_PAGES || chars > MAX_ADDRESS_CHARS) {
				more = true;
				break;
			}
			pages.push({ u: it.src, w: it.nw, h: it.nh });
		}
		return { pages, more };
	};

	const find = () => {
		const snapshot = collect();
		const { vw } = snapshot;
		const groups = groupsOf(snapshot);
		const biggest = groups[0] ?? [];
		const drawn = biggest.filter((it) => it.kind === 'canvas' || it.src.startsWith('blob:'));
		// A viewer that draws its pages gives them the column. A chart, a map or a search result's thumbnails are not one,
		// and telling someone their search results "cannot be read" helps nobody.
		const drawnLikeAPage = drawn.some((it) => it.w >= vw * 0.7 && it.h >= vw);
		const pager = hasPager();
		if (biggest.length && drawn.length * 2 >= biggest.length && drawnLikeAPage) return { kind: 'protected', pages: [], pager };
		const loading = loadingImages();
		for (const group of groups) {
			const { pages, more } = pagesOf(group);
			if (pages.length >= 2 && readsAsPages(group, vw)) return { kind: 'gallery', pages, pager, more, loading };
		}
		// One image is a comic page only when the viewer gives it the column and it stands upright: an article's photo is not a page.
		const { pages } = pagesOf(biggest);
		const lone = pages.length === 1 && biggest.some((it) => it.src === pages[0].u && it.w >= vw * 0.85 && shapeOf(it) >= MIN_PAGE_SHAPE);
		return lone ? { kind: 'single', pages, pager, more: false, loading } : { kind: 'none', pages: [], pager, more: false, loading };
	};

	const SOON = 400;
	const AT_MOST_EVERY = 3000;
	let timer = 0;
	let last = '';
	let delay = SOON;
	const scan = () => {
		timer = 0;
		// Nobody is looking: it looks again when the page is shown (`visibilitychange`).
		if (document.hidden) return;
		let report;
		try {
			report = find();
		} catch {
			return;
		}
		const key = JSON.stringify(report);
		// A page that keeps changing while its pages do not (an animation, a carousel) is looked at less and less often:
		// each look measures every image on the page.
		delay = key === last ? Math.min(delay * 1.5, AT_MOST_EVERY) : SOON;
		if (key === last) return;
		last = key;
		post({ t: 'finder', ...report, at: location.href });
	};
	const schedule = () => {
		if (!timer) timer = setTimeout(scan, delay);
	};
	// An image arrived or changed: that is what the finder is here for, and a viewer showing a page at a time may swap it
	// again in a moment, so it is looked at soon however quiet the page has been.
	const scheduleSoon = () => {
		delay = SOON;
		clearTimeout(timer);
		timer = setTimeout(scan, SOON);
	};
	const imageAttributes = new Set(['src', 'srcset', ...LAZY_ATTRS]);
	const touchesImages = (record) =>
		record.type === 'attributes'
			? imageAttributes.has(record.attributeName)
			: Array.from(record.addedNodes).some((node) => node.nodeName === 'IMG' || node.nodeName === 'CANVAS' || (node.querySelector && node.querySelector('img,canvas')));

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
		new MutationObserver((records) => (records.some(touchesImages) ? scheduleSoon() : schedule())).observe(document.documentElement, {
			subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcset', 'class', 'style', ...LAZY_ATTRS],
		});
		document.addEventListener('load', scheduleSoon, true);
		window.addEventListener('scroll', schedule, { passive: true });
		window.addEventListener('resize', schedule);
		// Single-page apps change pages without navigating.
		window.addEventListener('popstate', schedule);
		document.addEventListener('visibilitychange', schedule);
		schedule();
	};
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
	else start();
})();
