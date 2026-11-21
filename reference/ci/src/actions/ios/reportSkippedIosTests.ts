import { logLine, optionalEnv } from '../../ios/shared/actionIo.ts';

/**
 * `Skip iOS Tests`.
 *
 * Reports why the affected-test selector chose to run nothing on this lane.
 * The summary is a value the selector produced, so it arrives through `env:`
 * and is printed as data: interpolated into a shell body it would have been
 * parsed as shell.
 */

logLine(optionalEnv('IOS_TEST_SELECTION_SUMMARY'));
