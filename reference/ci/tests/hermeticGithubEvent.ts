/**
 * Loaded before every CI test process (`npm run ci:test`). A test that runs
 * inside a workflow job otherwise inherits that job's event: in a merge-queue
 * run, a spawned action reads the real merge_group payload instead of the
 * inputs the test passes, and fails its event-tuple check. Tests that need an
 * event set these variables explicitly.
 */
delete process.env['GITHUB_EVENT_NAME'];
delete process.env['GITHUB_EVENT_PATH'];
