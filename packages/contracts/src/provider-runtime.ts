export const providerRuntimeStates = [
  "idle",
  "running",
  "paused",
  "stopped",
  "error",
] as const;

export const providerRuntimeTransitionActorTypes = [
  "operator",
  "runner",
  "system",
] as const;

export type ProviderRuntimeState = (typeof providerRuntimeStates)[number];
export type ProviderRuntimeTransitionActorType =
  (typeof providerRuntimeTransitionActorTypes)[number];

export interface ProviderRuntimeTransitionRule {
  readonly from: ProviderRuntimeState;
  readonly to: ProviderRuntimeState;
  readonly actors: readonly ProviderRuntimeTransitionActorType[];
}

/**
 * The one application transition matrix for provider runtime authority.
 * Resume moves a paused/stopped/error runtime to idle; only a runner may then
 * begin work. Same-state requests are handled as semantic no-ops outside this
 * table and never allocate a generation or event.
 */
export const providerRuntimeTransitionMatrix = Object.freeze([
  { from: "idle", to: "running", actors: ["runner"] },
  { from: "idle", to: "paused", actors: ["operator"] },
  { from: "idle", to: "stopped", actors: ["operator"] },
  { from: "idle", to: "error", actors: ["runner", "system"] },
  { from: "running", to: "idle", actors: ["runner"] },
  { from: "running", to: "paused", actors: ["operator"] },
  { from: "running", to: "stopped", actors: ["operator"] },
  { from: "running", to: "error", actors: ["runner", "system"] },
  { from: "paused", to: "idle", actors: ["operator"] },
  { from: "paused", to: "stopped", actors: ["operator"] },
  { from: "paused", to: "error", actors: ["system"] },
  { from: "stopped", to: "idle", actors: ["operator"] },
  { from: "stopped", to: "error", actors: ["system"] },
  { from: "error", to: "idle", actors: ["operator"] },
  { from: "error", to: "paused", actors: ["operator"] },
  { from: "error", to: "stopped", actors: ["operator"] },
] as const satisfies readonly ProviderRuntimeTransitionRule[]);

export function providerRuntimeTransitionAllowed(input: {
  readonly from: ProviderRuntimeState;
  readonly to: ProviderRuntimeState;
  readonly actorType: ProviderRuntimeTransitionActorType;
}): boolean {
  return providerRuntimeTransitionMatrix.some(
    (rule) =>
      rule.from === input.from
      && rule.to === input.to
      && (rule.actors as readonly ProviderRuntimeTransitionActorType[]).includes(
        input.actorType,
      ),
  );
}

export function providerRuntimeStateRequiresReason(
  state: ProviderRuntimeState,
): boolean {
  return state === "paused" || state === "stopped" || state === "error";
}
