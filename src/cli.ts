import { readFileSync, writeFileSync } from 'node:fs';
import { planRepository, gitTreeDigest, balanceTests } from './core.ts';

const help = `FirehosePR — conservative CI planning

  fpr init                          Write firehosepr.json (never overwrite)
  fpr plan --base REF --head REF     Plan affected lanes as JSON
           [--config FILE] [--root DIR] [--full] [--out FILE]
  fpr fingerprint [--ref REF] [--root DIR]
  fpr shard --tests FILE [--count N]  Balance [{path, seconds}] as JSON

Paths in config are exact files or directory prefixes ending in /, not globs.
Unknown changed paths select every lane. Commands are argument arrays.
No command dispatches jobs, skips checks, deploys, or changes repository settings.
`;
export async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === 'help') { console.log(help); return; }
  if (command === '--version') { console.log('0.1.0'); return; }
  const allowed: Record<string, readonly string[]> = {
    init: [], plan: ['base', 'head', 'config', 'root', 'full', 'out'],
    fingerprint: ['ref', 'root'], shard: ['tests', 'count', 'out'],
  };
  const keys = allowed[command];
  if (!keys) throw new Error(`Unknown command ${command}. Run fpr --help.`);
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] ?? '';
    const key = token.slice(2);
    if (!token.startsWith('--') || !keys.includes(key) || flags.has(key)) throw new Error(`Unexpected option ${token}.`);
    const value = key === 'full' ? 'true' : rest[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${token}.`);
    flags.set(key, value);
  }
  const required = (key: string): string => {
    const value = flags.get(key); if (!value) throw new Error(`--${key} is required.`); return value;
  };
  const json = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8')) as unknown;
  let result: unknown;
  if (command === 'init') {
    const example = { schemaVersion: 1, maxShards: 4,
      globalInputs: ['package.json', 'package-lock.json', '.github/', 'firehosepr.json'],
      ignoredPaths: [], lanes: [{ id: 'tests', inputs: ['src/', 'tests/'], command: ['npm', 'test'] }] };
    writeFileSync('firehosepr.json', JSON.stringify(example, null, 2) + '\n', { flag: 'wx' });
    console.log('Created firehosepr.json. Review input ownership before using selective CI.'); return;
  }
  if (command === 'plan') result = planRepository(flags.get('root') ?? process.cwd(),
    json(flags.get('config') ?? 'firehosepr.json'), required('base'), required('head'), flags.has('full'));
  if (command === 'fingerprint') result = { treeDigest: gitTreeDigest(flags.get('root') ?? process.cwd(), flags.get('ref') ?? 'HEAD') };
  if (command === 'shard') result = balanceTests(json(required('tests')) as Parameters<typeof balanceTests>[0], Number(flags.get('count') ?? 4));
  const output = JSON.stringify(result, null, 2) + '\n';
  if (flags.has('out')) writeFileSync(required('out'), output); else process.stdout.write(output);
}
