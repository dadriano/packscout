/**
 * Migration state, derived by comparing the migrations present in the
 * repository against the history the database recorded.
 *
 * The whole point of this module is that history is a *log of attempts*, not a
 * list of migrations: one migration name can appear several times — applied,
 * rolled back, applied again. Aggregating by name is what makes the reading
 * truthful:
 *
 *  - a name with any attempt that finished and was not rolled back is applied,
 *    no matter how many failed attempts sit around it;
 *  - a name whose only attempts failed or were rolled back is failed;
 *  - a name the repository has and the database has never attempted is pending;
 *  - a name the database has and the repository does not is drift, reported
 *    rather than silently dropped.
 *
 * A database with no history at all therefore reads as *behind* — every
 * repository migration is pending — which is the honest answer for a fresh
 * database, and never "unknown".
 */

export interface MigrationHistoryRow {
  readonly name: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly rolledBackAt: string | null;
}

export type MigrationOutcome = "applied" | "failed" | "pending" | "unknown_to_repository";

export interface MigrationEntry {
  readonly name: string;
  readonly outcome: MigrationOutcome;
  /** How many rows in the history carry this name. */
  readonly attempts: number;
  readonly inRepository: boolean;
  /** Present for anything an operator has to act on. */
  readonly detail: string | null;
}

export type MigrationHealth = "current" | "behind" | "failed" | "drifted";

export interface MigrationStateSummary {
  readonly health: MigrationHealth;
  readonly repositoryCount: number;
  readonly appliedCount: number;
  readonly pending: readonly string[];
  readonly failed: readonly MigrationEntry[];
  readonly unknownToRepository: readonly string[];
  readonly entries: readonly MigrationEntry[];
  readonly summary: string;
}

function succeeded(row: MigrationHistoryRow): boolean {
  return row.finishedAt !== null && row.rolledBackAt === null;
}

function failureDetail(rows: readonly MigrationHistoryRow[]): string {
  const rolledBack = rows.some((row) => row.rolledBackAt !== null);
  const unfinished = rows.some(
    (row) => row.finishedAt === null && row.rolledBackAt === null,
  );
  if (rolledBack && unfinished) {
    return "Rolled back, and a later attempt never finished.";
  }
  if (rolledBack) return "Applied then rolled back; it is not in the database.";
  return "Started but never finished; the database may be part-migrated.";
}

function pluralMigrations(count: number): string {
  return count === 1 ? "1 migration" : `${count} migrations`;
}

function summarize(
  health: MigrationHealth,
  counts: {
    repositoryCount: number;
    appliedCount: number;
    pending: readonly string[];
    failed: readonly MigrationEntry[];
    unknownToRepository: readonly string[];
  },
): string {
  const applied = `${counts.appliedCount} of ${pluralMigrations(counts.repositoryCount)} applied`;
  if (health === "failed") {
    return `${pluralMigrations(counts.failed.length)} failed or were rolled back; ${applied}.`;
  }
  if (health === "behind") {
    return `${applied}; ${pluralMigrations(counts.pending.length)} pending.`;
  }
  if (health === "drifted") {
    return `${applied}, and the database holds ${pluralMigrations(counts.unknownToRepository.length)} this repository does not contain.`;
  }
  return `Migrations are current: ${applied}.`;
}

/**
 * Aggregate one history log against the repository's migration list. Pure, so
 * every case — fresh database, reapplied migration, failed migration, drift —
 * is directly testable without a database.
 */
export function summarizeMigrationState(
  repositoryMigrations: readonly string[],
  history: readonly MigrationHistoryRow[],
): MigrationStateSummary {
  const attemptsByName = new Map<string, MigrationHistoryRow[]>();
  for (const row of history) {
    const rows = attemptsByName.get(row.name);
    if (rows) rows.push(row);
    else attemptsByName.set(row.name, [row]);
  }

  const repositoryNames = [...repositoryMigrations].sort();
  const entries: MigrationEntry[] = repositoryNames.map((name) => {
    const rows = attemptsByName.get(name) ?? [];
    if (rows.length === 0) {
      return {
        name,
        outcome: "pending",
        attempts: 0,
        inRepository: true,
        detail: "Present in the repository, never attempted on this database.",
      };
    }
    if (rows.some(succeeded)) {
      return { name, outcome: "applied", attempts: rows.length, inRepository: true, detail: null };
    }
    return {
      name,
      outcome: "failed",
      attempts: rows.length,
      inRepository: true,
      detail: failureDetail(rows),
    };
  });

  const repositorySet = new Set(repositoryNames);
  const drift: MigrationEntry[] = [...attemptsByName.keys()]
    .filter((name) => !repositorySet.has(name))
    .sort()
    .map((name) => ({
      name,
      outcome: "unknown_to_repository" as const,
      attempts: attemptsByName.get(name)?.length ?? 0,
      inRepository: false,
      detail: "Recorded in the database but absent from this repository.",
    }));

  const pending = entries.filter((entry) => entry.outcome === "pending").map((e) => e.name);
  const failed = entries.filter((entry) => entry.outcome === "failed");
  const appliedCount = entries.filter((entry) => entry.outcome === "applied").length;
  const unknownToRepository = drift.map((entry) => entry.name);

  const health: MigrationHealth =
    failed.length > 0
      ? "failed"
      : pending.length > 0
        ? "behind"
        : unknownToRepository.length > 0
          ? "drifted"
          : "current";

  const counts = {
    repositoryCount: repositoryNames.length,
    appliedCount,
    pending,
    failed,
    unknownToRepository,
  };
  return {
    health,
    ...counts,
    entries: [...entries, ...drift],
    summary: summarize(health, counts),
  };
}
