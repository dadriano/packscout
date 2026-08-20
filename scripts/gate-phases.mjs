/**
 * The phase catalog the gate timing instrument measures.
 *
 * Phase names are the stable contract that timing records are compared against.
 * Adding a phase is safe. Renaming one silently breaks comparison with every
 * existing baseline, so treat these names as an interface.
 */

export const GATE_PHASES = Object.freeze([
  { group: "check", name: "check:boundaries" },
  { group: "check", name: "check:dependencies" },
  { group: "check", name: "check:docs" },
  { group: "check", name: "check:scripts" },
  { group: "check", name: "check:prisma-only" },
  { group: "check", name: "scan:framework-standards:ratchet" },

  { group: "lint", name: "lint:contracts" },
  { group: "lint", name: "lint:database" },
  { group: "lint", name: "lint:services" },
  { group: "lint", name: "lint:worker" },
  { group: "lint", name: "lint:frontend" },
  { group: "lint", name: "lint:admin" },

  { group: "typecheck", name: "typecheck:contracts" },
  { group: "typecheck", name: "typecheck:database" },
  { group: "typecheck", name: "typecheck:services" },
  { group: "typecheck", name: "typecheck:worker" },
  { group: "typecheck", name: "typecheck:convex" },
  { group: "typecheck", name: "typecheck:frontend" },
  { group: "typecheck", name: "typecheck:admin" },

  { group: "test", name: "test:contracts" },
  { group: "test", name: "test:database" },
  { group: "test", name: "test:services" },
  { group: "test", name: "test:worker" },
  { group: "test", name: "test:convex" },
  { group: "test", name: "test:frontend" },
  { group: "test", name: "test:admin" },
  { group: "test", name: "test:tooling" },

  // Only the frontend and admin produce an artifact. The other workspaces are
  // consumed as TypeScript, so their former "build" was their typecheck run a
  // second time and has been removed rather than measured.
  { group: "build", name: "build:frontend" },
  { group: "build", name: "build:admin" },
]);

export const GATE_PHASE_GROUPS = Object.freeze([
  ...new Set(GATE_PHASES.map((phase) => phase.group)),
]);

export function selectPhases(group) {
  if (!group) return [...GATE_PHASES];
  return GATE_PHASES.filter((phase) => phase.group === group);
}

export function formatDuration(durationMs) {
  return durationMs >= 10_000
    ? `${(durationMs / 1000).toFixed(1)}s`
    : `${durationMs}ms`;
}

export function summarize(results) {
  return {
    phases: results,
    totalMs: results.reduce((sum, entry) => sum + entry.durationMs, 0),
    failingPhases: results
      .filter((entry) => !entry.ok)
      .map((entry) => entry.phase),
  };
}

/**
 * Compares a fresh run against a recorded baseline, per phase.
 * Phases present in only one of the two are reported rather than dropped, so a
 * removed or renamed phase is visible instead of silently improving the total.
 */
export function compareToBaseline(baseline, current) {
  const baselineByPhase = new Map(
    (baseline?.phases ?? []).map((entry) => [entry.phase, entry]),
  );
  const currentByPhase = new Map(
    (current?.phases ?? []).map((entry) => [entry.phase, entry]),
  );
  const names = [
    ...new Set([...baselineByPhase.keys(), ...currentByPhase.keys()]),
  ];

  return names.map((phase) => {
    const before = baselineByPhase.get(phase);
    const after = currentByPhase.get(phase);
    return {
      phase,
      baselineMs: before?.durationMs ?? null,
      currentMs: after?.durationMs ?? null,
      deltaMs:
        before && after ? after.durationMs - before.durationMs : null,
      status: !before ? "added" : !after ? "removed" : "compared",
    };
  });
}
