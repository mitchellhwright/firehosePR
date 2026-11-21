/**
 * Writing `$GITHUB_OUTPUT` and `$GITHUB_ENV` from a typed step program.
 *
 * Every converted iOS step needs the same two things: render `key=value`
 * lines exactly as the shell did, and append them to the file GitHub named.
 * The rendering half is pure so a test can assert on the text a step would
 * write without touching a filesystem; the appending half is the only part
 * that performs I/O.
 *
 * Kept under `ci/src/ios/shared/` because several converted steps write
 * outputs and there must be exactly one implementation of the multi-line
 * delimiter form, which is the part that is easy to get subtly wrong.
 */
export type StepOutputEntry = readonly [name: string, value: string];
/**
 * The single-line form. GitHub splits on the first `=`, so a value that
 * contains a newline would be read as further keys; `renderMultilineOutput`
 * is the form for those.
 */
export declare function renderStepOutputs(entries: readonly StepOutputEntry[]): string;
/**
 * The heredoc form: `name<<DELIMITER`, the value, then the delimiter alone on
 * its own line. A value carrying the delimiter as a whole line would end the
 * block early and leak the rest into the file as further keys, so that is
 * rejected rather than written.
 */
export declare function renderMultilineOutput(name: string, value: string, delimiter: string): string;
export declare function appendStepOutputs(entries: readonly StepOutputEntry[]): void;
export declare function appendMultilineStepOutput(name: string, value: string, delimiter: string): void;
export declare function appendJobEnvironment(entries: readonly StepOutputEntry[]): void;
