/**
 * The subset of shell pattern matching the converted `case "$path" in …` step
 * bodies used: literals and `*`. `*` matches any run of characters including
 * `/`, exactly as it does inside a `case` pattern (unlike pathname expansion),
 * which is why `ios/*` selects `ios/firehosepr-ios/UI/HomeView.swift`.
 */
export declare function matchesCaseGlob(path: string, glob: string): boolean;
export declare function matchesAnyCaseGlob(path: string, globs: readonly string[]): boolean;
