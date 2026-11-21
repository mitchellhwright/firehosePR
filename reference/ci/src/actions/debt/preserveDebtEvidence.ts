import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface EvidenceSummaryInput {
  readonly runnerTemp: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly summaryPath: string;
}

function required(name: 'RUNNER_TEMP' | 'GITHUB_RUN_ID' | 'GITHUB_RUN_ATTEMPT' | 'GITHUB_STEP_SUMMARY'): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

/** Keep the old summary's 240-line limit without invoking a shell or sed. */
export function preserveDebtEvidence({ runnerTemp, runId, runAttempt, summaryPath }: EvidenceSummaryInput): void {
  const directory = join(runnerTemp, `debt-preflight-${runId}-${runAttempt}`);
  const sections = [
    '## Debt dependency evidence\n\n',
    'Artifact storage rejected the upload; retaining the bounded evidence in this job summary.\n\n',
  ];
  if (existsSync(directory)) {
    for (const file of readdirSync(directory).sort()) {
      const path = join(directory, file);
      if (!statSync(path).isFile()) continue;
      const contents = readFileSync(path, 'utf8').split('\n').slice(0, 240).join('\n');
      sections.push(`### ${basename(path)}\n\`\`\`text\n${contents}${contents.endsWith('\n') || contents.length === 0 ? '' : '\n'}\`\`\`\n`);
    }
  }
  appendFileSync(summaryPath, sections.join(''));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  preserveDebtEvidence({
    runnerTemp: required('RUNNER_TEMP'),
    runId: required('GITHUB_RUN_ID'),
    runAttempt: required('GITHUB_RUN_ATTEMPT'),
    summaryPath: required('GITHUB_STEP_SUMMARY'),
  });
}
