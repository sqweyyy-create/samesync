/* eslint-disable no-console -- CLI output */
import { fileURLToPath } from 'node:url';
import { validateContentDir } from './index';

const root = fileURLToPath(new URL('..', import.meta.url));
const { bundle, issues } = await validateContentDir(root);

if (issues.length > 0) {
  console.error(`content:check failed with ${issues.length} issue(s):`);
  for (const issue of issues) console.error(`  - ${issue.id}: ${issue.message}`);
  process.exit(1);
}

console.log(
  `content:check OK: ${bundle.questions.length} questions, ${bundle.categories.length} categories, ` +
    `${bundle.items.length} items, ${bundle.openers.length} openers, ${bundle.aliases.length} aliases, ` +
    `${bundle.products.length} products`,
);
