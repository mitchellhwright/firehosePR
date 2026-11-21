// Compare native execution inputs, keeping unfamiliar workflow syntax
// conservative. Linux jobs and native-job routing are exercised by Linux
// contracts; running an unrelated XCTest does not validate those decisions.
/**
 * @param {unknown} source
 * @returns {string | null}
 */
function nativeExecutionSource(source: unknown): string | null {
  if (typeof source !== 'string' || !source.includes('\njobs:\n')) return null;
  const jobsStart = source.indexOf('\njobs:\n') + '\njobs:\n'.length;
  // Validate the entire job boundary before discarding any Linux job. Inline
  // or quoted job keys must not be swallowed into the preceding job's slice;
  // root-level keys after jobs also affect execution and require native review.
  for (const line of source.slice(jobsStart).split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (/^ {4}/.test(line)) continue;
    if (!/^ {2}[a-zA-Z0-9_-]+:[ \t]*$/.test(line)) return null;
  }
  const actualJobs = [...source.matchAll(/^ {2}([a-zA-Z0-9_-]+):[ \t]*$/gm)]
    .filter(match => match.index >= jobsStart);
  if (actualJobs.length === 0) return null;
  if (new Set(actualJobs.map(match => match[1])).size !== actualJobs.length) return null;
  const hostedControlAnchor = /^ {4}runs-on: &ios-control-runner ubuntu-(?:latest|slim|\d+\.\d+)\s*$/m.test(source);
  const retained = [source.slice(0, jobsStart)];
  for (let index = 0; index < actualJobs.length; index++) {
    const start = actualJobs[index];
    if (start === undefined) throw new Error(`Workflow job match ${index} is missing.`);
    let job = source.slice(start.index, actualJobs[index + 1]?.index);
    // Only literal hosted Linux jobs can be discarded. An expression,
    // self-hosted runner, or newly introduced job remains a native input.
    if (/^ {4}runs-on: (?:&ios-control-runner )?ubuntu-(?:latest|slim|\d+\.\d+)\s*$/m.test(job)
      || (hostedControlAnchor && /^ {4}runs-on: \*ios-control-runner\s*$/m.test(job))) continue;
    job = job.replace(/^ {4}if:.*\n(?:^ {6,}.*\n|^\s*\n)*/gm, '');
    if (start[1] === 'test-ios-execution') {
      job = job.replace(
        /^ {6}- name: Determine Affected iOS Tests\n[\s\S]*?(?=^ {6}- |$(?![\s\S]))/m,
        '',
      );
    }
    if (start[1] === 'build-ios-native-test-products') {
      job = job.replace(
        /^ {6}- name: Determine native build selection\n[\s\S]*?(?=^ {6}- |$(?![\s\S]))/m,
        '',
      );
    }
    retained.push(job);
  }
  return retained.join('\n').split('\n')
    .filter(line => line.trim() && !line.trimStart().startsWith('#'))
    // Upload/download artifact revisions do not change which native products
    // are built or which XCTest commands execute. Their pins and inputs remain
    // covered by the required Linux workflow validation.
    .map(line => line.replace(
      /^(\s*uses:\s+actions\/(?:upload|download)-artifact)@[0-9a-f]{40}(?:\s+#.*)?$/,
      '$1@validated-by-linux',
    ))
    .map(line => line.trimEnd()).join('\n');
}

/**
 * @param {unknown} before
 * @param {unknown} after
 * @returns {boolean}
 */
export function workflowNeedsNativeExecution(before: unknown, after: unknown): boolean {
  const previous = nativeExecutionSource(before);
  const current = nativeExecutionSource(after);
  return previous === null || current === null || previous !== current;
}
