import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
const root = process.cwd();
const failures = [];
const rules = [
  ['private destination', /tobiwealth\.com|Tobi-Wealth|tobi-site\.iam|\/Users\/(?:mitchellwright|sagentlab)/iu],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ['credential', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})/u],
];
function scan(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) { failures.push(`${relative(root, path)}: symlink`); continue; }
    if (entry.isDirectory()) { scan(path); continue; }
    if (path === new URL(import.meta.url).pathname) continue;
    const text = readFileSync(path, 'utf8');
    for (const [label, pattern] of rules) if (pattern.test(text)) failures.push(`${relative(root, path)}: ${label}`);
  }
}
scan(root);
if (failures.length) throw new Error(`Export audit failed (values suppressed):\n${failures.join('\n')}`);
console.log('Export audit passed: no original deployment destinations or recognized credential patterns.');
