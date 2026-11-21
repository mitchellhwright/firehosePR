/**
 * The handful of `jq` behaviours the converted iOS steps depended on.
 *
 * Every one of those tests ran as `jq -e '<filter>' <<< "$VALUE"`, whose exit
 * status the shell read as a boolean: 0 when the filter produced a truthy
 * value, non-zero when it produced `false`/`null` *or* when jq itself failed on
 * a value of the wrong type. Reproducing the failure cases matters as much as
 * the success cases, because a malformed input reached the `else` branch rather
 * than stopping the step.
 */

/** `length`: jq measures arrays, strings and objects, and fails on a boolean. */
export function jqLength(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'string') return value.length;
  if (typeof value === 'number') return Math.abs(value);
  if (typeof value === 'object') return Object.keys(value).length;
  return 0;
}

/** `index($needle) != null`: jq fails on anything but an array or a string. */
export function jqIndexPresent(value: unknown, needle: string): boolean {
  if (Array.isArray(value)) return value.includes(needle);
  if (typeof value === 'string') return value.includes(needle);
  return false;
}

/** `all(.[]; <predicate>)` over an array; jq fails on a non-array, which reads as false. */
export function jqAllElements(value: unknown, predicate: (element: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(predicate);
}

/** `any(.[]; <predicate>)` over an array; jq fails on a non-array, which reads as false. */
export function jqAnyElement(value: unknown, predicate: (element: unknown) => boolean): boolean {
  return Array.isArray(value) && value.some(predicate);
}

/**
 * `join($separator)`: jq renders null as the empty string and numbers and
 * booleans as their JSON text, and fails on a nested array or object. A failed
 * `$(jq …)` substitution left the shell holding the empty string.
 */
export function jqJoin(value: unknown, separator: string): string {
  if (!Array.isArray(value)) return '';
  const rendered: string[] = [];
  for (const element of value) {
    if (element === null) { rendered.push(''); continue; }
    if (typeof element === 'string') { rendered.push(element); continue; }
    if (typeof element === 'number' || typeof element === 'boolean') {
      rendered.push(String(element));
      continue;
    }
    return '';
  }
  return rendered.join(separator);
}

/**
 * Parses the document `jq` was fed; malformed input is `undefined`, on which
 * every test above is false.
 */
export function parseJqDocument(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
