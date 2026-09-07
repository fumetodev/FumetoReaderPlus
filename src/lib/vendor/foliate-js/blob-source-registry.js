// @ts-nocheck — local helper beside the vendored files; see PROVENANCE.md
// Not an upstream file — see PROVENANCE.md.
//
// The EPUB loader hands each section to the paginator as a `blob:` URL. On
// WebKitGTK inside a custom-scheme app (the Linux desktop build) a frame
// loaded from such a URL is treated as cross-origin, and the page's content
// security policy blocks fetching the URL back, so the paginator would have
// no way to read the section. The loader therefore remembers the text it
// put behind each URL, and the paginator inlines it as `srcdoc` on hosts
// where a probe shows blob frames are opaque.

const sources = new Map()

export const rememberBlobSource = (url, data, type) => {
    if (typeof data === 'string') sources.set(url, { data, type })
}

export const forgetBlobSource = url => {
    sources.delete(url)
}

export const blobSourceFor = url => sources.get(url)
