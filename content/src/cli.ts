/* eslint-disable no-console -- CLI output */
/**
 *   pnpm content:check            validate content/ (including the lockfile)
 *   pnpm content:check --launch   also require launch-sized decks and catalog
 *   pnpm content:lock             rewrite content.lock.json after a legitimate change
 */
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { validateContentDir, writeLockFile, type ContentIssue } from './index';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { launch: { type: 'boolean', default: false } },
});
const command = positionals[0] ?? 'check';
const root = fileURLToPath(new URL('..', import.meta.url));

function fail(title: string, issues: ContentIssue[]): never {
  console.error(`${title} with ${issues.length} issue(s):`);
  for (const issue of issues) console.error(`  - ${issue.id}: ${issue.message}`);
  process.exit(1);
}

if (command === 'lock') {
  const { issues, written } = await writeLockFile(root);
  if (!written) fail('content:lock refused to write content.lock.json', issues);
  console.log('content:lock wrote content.lock.json');
} else if (command === 'check') {
  const { bundle, issues } = await validateContentDir(root, { launch: values.launch });
  const name = values.launch ? 'content:check --launch' : 'content:check';
  if (issues.length > 0) fail(`${name} failed`, issues);
  console.log(
    `${name} OK (release ${bundle.release?.version}): ${bundle.questions.length} questions, ` +
      `${bundle.stances.length} stances, ` +
      `${bundle.categories.length} categories, ${bundle.items.length} items, ` +
      `${bundle.genders.length} dating options, ${bundle.openers.length} openers, ` +
      `${bundle.aliases.length} aliases, ${bundle.products.length} products`,
  );
} else {
  console.error(`unknown command "${command}" (use "check" or "lock")`);
  process.exit(1);
}
