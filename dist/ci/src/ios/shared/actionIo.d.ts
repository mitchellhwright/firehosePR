/**
 * The GitHub Actions step boundary: reading `env`, writing `$GITHUB_OUTPUT`
 * and `$GITHUB_ENV`, and emitting workflow annotations.
 *
 * Shared by every typed iOS step so a program never re-implements `${VAR:?}`
 * or an `appendFileSync` to the wrong file. Placed under `ios/shared` because
 * the iOS workflow is being converted step by step; when the other steps land
 * this is the module they import rather than copy. It carries only what a
 * converted step uses today — a step that needs a `$GITHUB_OUTPUT` writer or a
 * `::warning::` adds it here, not beside itself.
 */
/** The shell's `${NAME:?}`: present and non-empty, or the step fails closed. */
export declare function requiredEnv(name: string, environment?: NodeJS.ProcessEnv): string;
/** The shell's `${NAME:-default}`. */
export declare function optionalEnv(name: string, fallback?: string, environment?: NodeJS.ProcessEnv): string;
/** The shell's `[ "$NAME" = "true" ]`; every other value, including blank, is false. */
export declare function booleanEnv(name: string, environment?: NodeJS.ProcessEnv): boolean;
/** Exports a whole block in one append, as the shell's `{ ... } >> $GITHUB_ENV` did. */
export declare function exportStepEnvBlock(entries: ReadonlyMap<string, string>): void;
/** The shell's `echo … >> "$GITHUB_STEP_SUMMARY"`; the newline is added here. */
export declare function appendStepSummary(line: string): void;
/**
 * Prepends a directory to `PATH` for every later step, as `echo … >>
 * "$GITHUB_PATH"` did. The current process keeps its own `PATH` unchanged, so
 * a step that also needs the directory itself uses the resolved binary.
 */
export declare function exportStepPath(directory: string): void;
/** Plain step-log output; annotations already carry their own `::` prefix. */
export declare function logLine(message: string): void;
export declare function annotateError(message: string): void;
export declare function annotateNotice(message: string): void;
export declare function annotateWarning(message: string): void;
