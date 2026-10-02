import { checkContent, type ContentBundle, type ContentIssue } from './check';
import { loadContent } from './load';

export * from './schema';
export { checkContent, loadContent, type ContentBundle, type ContentIssue };

/** Loads `root` and runs every check. An empty `issues` list means the content is valid. */
export async function validateContentDir(
  root: string,
): Promise<{ bundle: ContentBundle; issues: ContentIssue[] }> {
  const { bundle, issues } = await loadContent(root);
  return { bundle, issues: [...issues, ...checkContent(bundle)] };
}
