import { readFileSync, type PathOrFileDescriptor } from 'node:fs';

/**
 * Source-contract suites match against repository text with literal `\n`
 * anchors. A Windows checkout stores the same files with CRLF endings, so the
 * comparison has to happen on one canonical representation. Normalizing at the
 * read boundary keeps every downstream assertion strict while letting the same
 * suite pass on Windows and POSIX.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeSourceText(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/**
 * Read a repository file as canonical LF source text.
 *
 * @param {import('node:fs').PathOrFileDescriptor} target
 * @returns {string}
 */
export function readSourceText(target: PathOrFileDescriptor): string {
  return normalizeSourceText(readFileSync(target, 'utf8'));
}

/**
 * Produce the Windows representation of the same logical source. Used by the
 * regression checks that prove the guards no longer depend on the checkout's
 * line endings.
 *
 * @param {string} text
 * @returns {string}
 */
export function toCrlfSourceText(text: string): string {
  return normalizeSourceText(text).replace(/\n/g, '\r\n');
}
