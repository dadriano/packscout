/**
 * Single source of truth for directories that repository gates never inspect.
 *
 * Every checker, scanner, test runner, and lint configuration imports from here.
 * Maintaining these lists separately let them drift: gates reported findings for
 * files inside agent worktrees and generated bundler output, which are not part
 * of the codebase under review.
 *
 * Matching is by name and prefix rather than by an enumerated list of known
 * paths, so a newly created worktree or a bundler output directory named through
 * an environment variable is covered without another edit here.
 */

/** Directory names skipped anywhere they appear in the tree. */
export const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".turbo",
  "node_modules",
  "build",
  "dist",
  "coverage",
  "playwright-report",
  "test-results",
  // Agent and developer worktrees. `.worktrees` is this repository's own
  // convention; the bare name covers nested locations such as
  // `.claude/worktrees` that tooling also creates.
  ".worktrees",
  "worktrees",
]);

/**
 * Generated bundler output. `next.config.ts` resolves its output directory from
 * `NEXT_DIST_DIR`, so the name is not fixed and cannot be enumerated. Every
 * directory beginning with `.next` is generated output.
 */
const GENERATED_OUTPUT_PREFIX = ".next";

/**
 * True when a directory with this name should never be walked, regardless of
 * where it sits in the tree.
 */
export function isIgnoredDirectoryName(name) {
  return (
    IGNORED_DIRECTORY_NAMES.has(name) || name.startsWith(GENERATED_OUTPUT_PREFIX)
  );
}

/**
 * Builds a skip predicate that also honours a consumer's own additions, for
 * gates that legitimately skip more than the shared set.
 */
export function createDirectorySkipPredicate(additionalNames = []) {
  const additional = new Set(additionalNames);
  return (name) => isIgnoredDirectoryName(name) || additional.has(name);
}

/**
 * The same rules expressed as glob patterns, for tools configured with globs
 * rather than a directory walk.
 */
export const IGNORED_GLOBS = [
  ...[...IGNORED_DIRECTORY_NAMES].map((name) => `**/${name}/**`),
  `**/${GENERATED_OUTPUT_PREFIX}*/**`,
];
