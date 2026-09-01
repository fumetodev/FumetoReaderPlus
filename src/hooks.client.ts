/**
 * Client hooks — installed before the app mounts.
 *
 * This module exists so unhandled faults are captured from the earliest moment
 * possible. A fault during startup is exactly the one a tester cannot describe
 * and cannot recover from, and until this landed the app had no window.onerror,
 * no unhandledrejection handler, and no error boundary at all.
 */

import type { HandleClientError } from '@sveltejs/kit';
import { installGlobalErrorCapture, recordError } from '$lib/diagnostics/error-ring.js';

installGlobalErrorCapture();

/**
 * SvelteKit routes navigation/render faults here rather than to window.onerror,
 * so both paths have to feed the same ring.
 */
export const handleError: HandleClientError = ({ error, event, status, message }) => {
	recordError('sveltekit', error, `${status} ${event?.url?.pathname ?? ''}`.trim());
	return { message };
};
