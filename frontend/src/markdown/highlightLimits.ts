/**
 * Code longer than this skips syntax highlighting to avoid blocking the main
 * thread on very large blocks (plan §3.4). Content still renders as plain text.
 *
 * Kept in its own dependency-free module so components can read the threshold
 * without statically pulling in highlight.js, preserving the lazy import.
 */
export const HIGHLIGHT_MAX_CHARS = 50_000;
