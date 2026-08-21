import {
  buildDatabaseStatus,
  type DatabaseProbeResult,
  type DatabaseStatusSnapshot,
} from "./core/database-status.ts";
import {
  readDatabaseConnectionSecret,
  resolveDatabaseTarget,
  type DatabaseTargetFacts,
} from "./core/database-target.ts";
import type { StudioSupervisor } from "./core/studio-supervisor.ts";
import { probeDatabase } from "./database-probe.ts";
import { readRepositoryMigrations } from "./repository-migrations.ts";

/**
 * The panel's live view of the database.
 *
 * It keeps one composed snapshot and republishes it on two triggers: a bounded
 * refresh (on demand, and on an interval while anyone is watching) and any
 * change in the row browser's supervision state. Row-browser changes recompose
 * from the cached probe rather than re-reading the database, so a crash shows up
 * immediately without a round trip.
 *
 * The target is re-resolved from the environment on every refresh, so a change
 * to the environment is reflected rather than cached from startup.
 */

export interface DatabaseMonitorOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly migrationsDirectory: string;
  readonly supervisor: StudioSupervisor;
  readonly refreshIntervalMs: number;
  readonly probe?: typeof probeDatabase;
  readonly listMigrations?: typeof readRepositoryMigrations;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
}

export interface DatabaseMonitor {
  /** The last composed snapshot, refreshing first if none exists yet. */
  current(): Promise<DatabaseStatusSnapshot>;
  refresh(): Promise<DatabaseStatusSnapshot>;
  subscribe(listener: (snapshot: DatabaseStatusSnapshot) => void): () => void;
  stop(): void;
}

interface ProbedState {
  readAt: string;
  target: DatabaseTargetFacts;
  probe: DatabaseProbeResult | null;
  repositoryMigrations: string[];
}

export function createDatabaseMonitor({
  env,
  migrationsDirectory,
  supervisor,
  refreshIntervalMs,
  probe = probeDatabase,
  listMigrations = readRepositoryMigrations,
  now = () => new Date(),
  onError,
}: DatabaseMonitorOptions): DatabaseMonitor {
  const listeners = new Set<(snapshot: DatabaseStatusSnapshot) => void>();
  let probed: ProbedState | undefined;
  let inFlight: Promise<DatabaseStatusSnapshot> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let releaseSupervisor: (() => void) | undefined;

  function compose(state: ProbedState): DatabaseStatusSnapshot {
    return buildDatabaseStatus({
      readAt: state.readAt,
      target: state.target,
      probe: state.probe,
      repositoryMigrations: state.repositoryMigrations,
      rowBrowser: {
        state: supervisor.state(),
        startupTimeoutMs: supervisor.startupTimeoutMs,
      },
      refreshIntervalMs,
    });
  }

  function publish(): void {
    if (!probed || listeners.size === 0) return;
    const snapshot = compose(probed);
    for (const listener of listeners) listener(snapshot);
  }

  async function read(): Promise<DatabaseStatusSnapshot> {
    const target = resolveDatabaseTarget(env);
    const connectionString = readDatabaseConnectionSecret(env);
    const [repositoryMigrations, result] = await Promise.all([
      listMigrations(migrationsDirectory).catch((error: unknown) => {
        onError?.(error);
        return [] as string[];
      }),
      target.identity === null || connectionString === undefined
        ? Promise.resolve(null)
        : probe({ connectionString }),
    ]);
    probed = { readAt: now().toISOString(), target, probe: result, repositoryMigrations };
    publish();
    return compose(probed);
  }

  function ticking(active: boolean): void {
    if (active && interval === undefined && refreshIntervalMs > 0) {
      interval = setInterval(() => {
        void refresh().catch((error: unknown) => onError?.(error));
      }, refreshIntervalMs);
      interval.unref?.();
      return;
    }
    if (!active && interval !== undefined) {
      clearInterval(interval);
      interval = undefined;
    }
  }

  function refresh(): Promise<DatabaseStatusSnapshot> {
    // Serialized: several viewers refreshing at once share one database read.
    inFlight ??= read().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  return {
    refresh,
    current: () => (probed ? Promise.resolve(compose(probed)) : refresh()),

    subscribe(listener) {
      listeners.add(listener);
      releaseSupervisor ??= supervisor.subscribe(() => publish());
      ticking(true);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) ticking(false);
      };
    },

    stop() {
      ticking(false);
      listeners.clear();
      releaseSupervisor?.();
      releaseSupervisor = undefined;
    },
  };
}
