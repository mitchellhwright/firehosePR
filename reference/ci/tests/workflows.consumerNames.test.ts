import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { definitions } from '../workflows/all.ts';
import {
  CONSUMER_NAMES_MODULE, consumerNames, renderConsumerModule,
} from '../workflows/lib/consumerNames.ts';
import { nameMatcher, retiredLiteralPrefix, type NameMatcher } from '../workflows/lib/names.ts';
import { scriptsTypecheckEntries } from '../src/typingCoverage.ts';

/**
 * A rendered job name is an interface: five Node controllers read it back off
 * the GitHub API and branch on it. Typing only the side that emits the name is
 * what let `Capture Dependabot base edit PR 42` become
 * `Capture a Dependabot base edit (42)` while the consumer still matched the
 * old spelling — and the old spelling is what a live Dependabot pull request
 * needs to refresh its checks. These tests make the consumer side type-checked
 * too: the names are generated, the matchers are generated with them, and a
 * raw literal in scripts/ is a failure rather than a latent break.
 */

function filesUnder(directory: string, extensions: readonly string[]): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return filesUnder(path, extensions);
    return extensions.some((extension) => path.endsWith(extension)) ? [path] : [];
  });
}

/** Prose goes stale without breaking anything; a string or a regex does not. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
    .replace(/^[ \t]*#.*$/gm, ' ');
}

test('the generated typed consumer module is in sync with the definitions', () => {
  assert.equal(readFileSync(CONSUMER_NAMES_MODULE, 'utf8'), renderConsumerModule(definitions));
});

test('every migrated workflow and job publishes its name and a matcher for it', () => {
  const names = consumerNames(definitions);
  assert.equal(names.size, definitions.length);
  for (const definition of definitions) {
    const slug = definition.config.path.replace(/^\.github\/workflows\//, '').replace(/\.ya?ml$/, '');
    const entry = names.get(slug);
    assert.ok(entry !== undefined, `${slug} must appear in the consumer name module`);
    assert.equal(entry.workflow, definition.config.name);
    for (const job of definition.config.jobs) {
      const published: NameMatcher | undefined = entry.jobs[job.id];
      assert.ok(published !== undefined, `${slug}.${job.id} must publish its rendered name`);
      assert.deepEqual(published, nameMatcher(job.config.name, job.config.retiredNamePatterns));
    }
  }
});

test('a generated matcher matches every name GitHub can render for its job', () => {
  for (const definition of definitions) {
    for (const job of definition.config.jobs) {
      const matcher = nameMatcher(job.config.name, job.config.retiredNamePatterns);
      const pattern = new RegExp(matcher.pattern);
      for (const literal of matcher.literals) {
        const rendered = matcher.suffixed ? `${literal} (anything at all)` : literal;
        assert.match(rendered, pattern, `${definition.config.path}:${job.id} cannot match its own rendered name`);
      }
    }
  }
});

/**
 * The names a step script is pinned to, by script path. A `.sh` cannot import
 * the generated module, so its step's `pinnedNames` carries the spellings the
 * script must contain — checked below, which is what makes a rename fail here
 * rather than downstream.
 */
function pinnedNames(): ReadonlyMap<string, readonly string[]> {
  const pins = new Map<string, readonly string[]>();
  for (const definition of definitions) {
    for (const job of definition.config.jobs) {
      for (const step of job.config.steps) {
        const { script, pinnedNames: names } = step.config;
        if (script === undefined || names === undefined) continue;
        pins.set(script, names);
      }
    }
  }
  return pins;
}

/**
 * Only the controllers, not their tests. A test that spells a name out fails
 * the moment the name changes, which is the signal we want; a controller that
 * spells one out keeps running and quietly matches nothing, which is the
 * failure this ban exists to make impossible.
 *
 * A step script that declares `pinnedNames` is exempt for exactly the names it
 * pins, because the test below re-derives them from the definition that
 * renders them: a rename fails that test instead of passing this one.
 */
test('no controller hardcodes the name of a migrated workflow or job', () => {
  const published: Map<string, string> = new Map();
  for (const definition of definitions) {
    published.set(definition.config.name, `${definition.config.path} (the workflow name)`);
    for (const job of definition.config.jobs) {
      for (const literal of nameMatcher(job.config.name, job.config.retiredNamePatterns).literals) {
        published.set(literal, `${definition.config.path}:${job.id}`);
      }
    }
  }
  const consumers = filesUnder('scripts', ['.mjs', '.js', '.ts', '.sh'])
    .filter((path) => !path.startsWith('scripts/tests/'))
    .filter((path) => path !== CONSUMER_NAMES_MODULE);
  const pins = pinnedNames();
  const violations: string[] = [];
  for (const path of consumers) {
    const source = withoutComments(readFileSync(path, 'utf8'));
    const pinned = pins.get(path) ?? [];
    for (const [literal, owner] of published) {
      if (!source.includes(literal)) continue;
      if (pinned.some((name) => name.includes(literal))) continue;
      violations.push(
        `${path} hardcodes ${JSON.stringify(literal)}, which ${owner} renders; `
        + `import it from ${CONSUMER_NAMES_MODULE} so a rename cannot leave this behind`,
      );
    }
  }
  assert.deepEqual(violations, []);
});

/**
 * The other half of that exemption. `pinnedNames` is built in the definition
 * from the job it names, so the day that job is renamed the pin changes and
 * the script no longer contains it — which is this assertion, and the reason a
 * `.sh` may spell a name at all.
 */
test('a step script contains every name its definition pins it to', () => {
  const missing: string[] = [];
  for (const [script, names] of pinnedNames()) {
    const source = readFileSync(script, 'utf8');
    for (const name of names) {
      if (source.includes(name)) continue;
      missing.push(`${script} is pinned to ${JSON.stringify(name)} but does not contain it`);
    }
  }
  assert.deepEqual(missing, []);
});

/**
 * A hand-written workflow cannot import the generated names, so it spells them
 * — which makes workflow YAML the place a rename is most likely to escape, and
 * where one did. `confirm-capture` in refresh-pr-ci-after-base-edit.yml counted
 * jobs matching `^Capture Dependabot base edit PR [1-9][0-9]*$` in a jq filter.
 * After the rename it matched nothing, so it confirmed nothing, so no
 * Dependabot base edit refreshed its checks — and confirming nothing is a
 * success, so no check went red. The first sweep missed it by scanning
 * `scripts/` only.
 *
 * The invariant is not "no retired name anywhere": accepting one is correct
 * while runs from before the rename are still open. It is that whatever
 * matches the retired spelling must match the current one too.
 */
test('anything matching a retired job name also matches the name rendered today', () => {
  const consumers = [
    ...filesUnder('scripts', ['.mjs', '.js', '.ts', '.sh']),
    ...filesUnder('.github/workflows', ['.yml', '.yaml']),
  ].filter((path) => path !== CONSUMER_NAMES_MODULE);
  const violations: string[] = [];
  for (const definition of definitions) {
    for (const job of definition.config.jobs) {
      const retired = (job.config.retiredNamePatterns ?? [])
        .map(retiredLiteralPrefix)
        .filter((prefix) => prefix !== '');
      if (retired.length === 0) continue;
      const current = nameMatcher(job.config.name).literals;
      for (const path of consumers) {
        const source = readFileSync(path, 'utf8');
        const stale = retired.find((prefix) => source.includes(prefix));
        if (stale === undefined) continue;
        if (current.some((literal) => source.includes(literal))) continue;
        violations.push(
          `${path} matches the retired name ${JSON.stringify(stale)} for `
          + `${definition.config.path}:${job.id} but never ${JSON.stringify(current[0])}, `
          + 'which is the name that job renders today',
        );
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('the generated name module is type-checked with its importers', () => {
  const checked = new Set(scriptsTypecheckEntries(process.cwd()));
  assert.ok(
    checked.has(CONSUMER_NAMES_MODULE),
    `${CONSUMER_NAMES_MODULE} must be in ci/tsconfig.scripts.json so npm run ci:typecheck:scripts checks it`,
  );
});
