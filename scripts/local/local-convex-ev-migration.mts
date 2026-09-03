import { canonicalJson } from "@packscout/contracts";

type Operation = "state" | "progress" | "page" | "initialize";
type ObjectValue = Record<string, unknown>;
type Pointer = ObjectValue & { publicReleaseId: string; counts: { repacks: number } };
type Pins = {
  expectedGeneration: number;
  expectedActivePublicReleaseId: string | null;
  expectedPreviousPublicReleaseId: string | null;
};
type State = Pins & { activeRelease: Pointer | null; previousRelease: Pointer | null; initialized: boolean };
export interface LocalEvMigrationClient {
  call(operation: Operation, args: ObjectValue): Promise<unknown>;
  verifyPublicRead(publicReleaseId: string): Promise<void>;
}

function refuse(code = "LOCAL_CONVEX_EV_MIGRATION_INVALID"): never { throw new Error(code); }
function object(value: unknown): ObjectValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return refuse();
  return value as ObjectValue;
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1_000) return refuse();
  return value;
}
function id(value: unknown): string | null {
  if (value === null || (typeof value === "string" && /^[0-9a-f-]{36}$/u.test(value))) return value;
  return refuse();
}
function pins(value: ObjectValue): Pins {
  const generation = value.expectedGeneration;
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) return refuse();
  return { expectedGeneration: generation,
    expectedActivePublicReleaseId: id(value.expectedActivePublicReleaseId),
    expectedPreviousPublicReleaseId: id(value.expectedPreviousPublicReleaseId) };
}
function pointer(value: unknown, expectedId: string | null): Pointer | null {
  if (expectedId === null) return value === null ? null : refuse();
  const parsed = object(value);
  if (parsed.publicReleaseId !== expectedId || typeof parsed.releaseFingerprint !== "string" ||
      !/^[0-9a-f]{64}$/u.test(parsed.releaseFingerprint) || typeof parsed.completedAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.completedAt))) return refuse();
  count(object(parsed.counts).repacks);
  return parsed as Pointer;
}
function state(value: unknown): State {
  const parsed = object(value);
  const scope = pins(parsed);
  if (typeof parsed.initialized !== "boolean" ||
      (scope.expectedActivePublicReleaseId === null &&
        (scope.expectedPreviousPublicReleaseId !== null || !parsed.initialized))) return refuse();
  return { ...scope, initialized: parsed.initialized,
    activeRelease: pointer(parsed.activeRelease, scope.expectedActivePublicReleaseId),
    previousRelease: pointer(parsed.previousRelease, scope.expectedPreviousPublicReleaseId) };
}
function proof(value: State): string {
  return canonicalJson({ ...pins(value), activeRelease: value.activeRelease, previousRelease: value.previousRelease });
}
function progress(value: unknown, target: Pointer) {
  const parsed = object(value);
  const accepted = count(parsed.count);
  const cursor = id(parsed.nextCursor);
  if (parsed.publicReleaseId !== target.publicReleaseId || typeof parsed.complete !== "boolean" ||
      accepted > target.counts.repacks || (parsed.complete && accepted !== target.counts.repacks) ||
      (accepted === 0) !== (cursor === null)) return refuse();
  return { complete: parsed.complete, count: accepted, nextCursor: cursor };
}

/** Does not deploy code, touch source cursors, or require a working public predecessor. */
export async function migrateLocalConvexEv(client: LocalEvMigrationClient, options: { checkOnly?: boolean } = {}) {
  const initial = state(await client.call("state", {}));
  const scope = pins(initial); // Never replace these CAS pins with a later progress response.
  if (!initial.initialized && options.checkOnly === true) {
    return { status: "migration_required" as const, ...scope };
  }
  if (!initial.initialized) {
    for (const target of [initial.previousRelease, initial.activeRelease]) {
      if (target === null) continue;
      const status = object(await client.call("progress", { publicReleaseId: target.publicReleaseId }));
      if (canonicalJson(pins(status)) !== canonicalJson(scope)) return refuse("LOCAL_CONVEX_EV_MIGRATION_POINTER_CHANGED");
      let previous = progress(status, target);
      // The backend caps pages at 32 rows / 4 MiB. One row per page is the
      // conservative upper bound even for maximum-size valid stored details.
      for (let page = 0; !previous.complete; page += 1) {
        if (page >= 1_001) return refuse();
        const next = progress(await client.call("page", { ...scope,
          publicReleaseId: target.publicReleaseId, afterPublicRepackId: previous.nextCursor }), target);
        if (!next.complete && (next.count <= previous.count || next.nextCursor === null ||
            (previous.nextCursor !== null && next.nextCursor <= previous.nextCursor))) return refuse();
        previous = next;
      }
    }
    await client.call("initialize", { ...scope, publicReleaseId: initial.expectedActivePublicReleaseId });
  }
  const ready = state(await client.call("state", {}));
  if (proof(initial) !== proof(ready)) return refuse("LOCAL_CONVEX_EV_MIGRATION_POINTER_CHANGED");
  if (!ready.initialized) return refuse("LOCAL_CONVEX_EV_MIGRATION_REQUIRED");
  if (ready.expectedActivePublicReleaseId !== null) await client.verifyPublicRead(ready.expectedActivePublicReleaseId);
  const final = state(await client.call("state", {}));
  if (proof(ready) !== proof(final)) return refuse("LOCAL_CONVEX_EV_MIGRATION_POINTER_CHANGED");
  if (!final.initialized) return refuse("LOCAL_CONVEX_EV_MIGRATION_REQUIRED");
  return { status: "ready" as const, ...scope };
}

export async function requireLocalConvexEvReady(client: LocalEvMigrationClient): Promise<void> {
  if ((await migrateLocalConvexEv(client, { checkOnly: true })).status !== "ready") {
    return refuse("LOCAL_CONVEX_EV_MIGRATION_REQUIRED");
  }
}

export async function withLocalConvexEvReady<T>(client: LocalEvMigrationClient, publish: () => Promise<T>): Promise<T> {
  await requireLocalConvexEvReady(client);
  return await publish();
}
