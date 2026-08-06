// Node's test runner treats positional paths as glob patterns. Escape glob
// metacharacters so tests inside Next.js dynamic routes such as `[id]` execute.
export function escapeGlobPath(pathString) {
  return pathString.replace(/[[\]*?{}]/g, (character) => `[${character}]`);
}
