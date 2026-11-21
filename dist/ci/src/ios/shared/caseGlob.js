/**
 * The subset of shell pattern matching the converted `case "$path" in …` step
 * bodies used: literals and `*`. `*` matches any run of characters including
 * `/`, exactly as it does inside a `case` pattern (unlike pathname expansion),
 * which is why `ios/*` selects `ios/firehosepr-ios/UI/HomeView.swift`.
 */
const specialCharacters = /[.+^${}()|[\]\\?]/g;
function toPattern(glob) {
    return new RegExp(`^${glob.replace(specialCharacters, '\\$&').replaceAll('*', '.*')}$`);
}
// Compiling the same glob for every changed path in a large pull request is
// pure waste; the pattern set is fixed at module scope, so cache by text.
const compiled = new Map();
export function matchesCaseGlob(path, glob) {
    let pattern = compiled.get(glob);
    if (pattern === undefined) {
        pattern = toPattern(glob);
        compiled.set(glob, pattern);
    }
    return pattern.test(path);
}
export function matchesAnyCaseGlob(path, globs) {
    return globs.some((glob) => matchesCaseGlob(path, glob));
}
