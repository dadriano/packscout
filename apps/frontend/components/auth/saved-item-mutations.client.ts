import { SAVED_CATALOG_ITEM_LIMIT, packCatalogUuidSchema, savedCatalogItemIdsSchema, savedCatalogItemsV1Contract } from "@packscout/contracts";
import { isSuspendedAccountRefusal, readRefusalCode } from "./account-standing";
import { presentSavedItemMutationMessage, type SavedItemKind, type SavedItemMessage } from "./saved-item-presentation";

export const SAVED_ITEM_MESSAGE_LIMIT = 50;
const MAX_PENDING = 2 * SAVED_CATALOG_ITEM_LIMIT;

type MutationState = Readonly<{
  pending: Readonly<Record<string, boolean>>;
  messages: Readonly<Record<string, SavedItemMessage>>;
  refusedAsSuspended: boolean;
}>;

const emptyState: MutationState = Object.freeze({ pending: {}, messages: {}, refusedAsSuspended: false });

export function savedItemKey(kind: SavedItemKind, id: string): string {
  const identity = packCatalogUuidSchema.safeParse(id);
  return `${kind}:${identity.success ? identity.data : "invalid"}`;
}

function refusal(code: string) {
  return { data: { code } };
}

/**
 * UI mutation coordination, scoped to one mounted authenticated session.
 * Saved membership always comes from the validated live query, never an optimistic set.
 */
export function createSavedItemMutations(ports: Readonly<{
  setSavedRepack: (args: { publicRepackId: string; saved: boolean }) => Promise<unknown>;
  setSavedCollectible: (args: { publicCollectibleId: string; saved: boolean }) => Promise<unknown>;
  getSavedItemIds: () => Promise<unknown>;
}>) {
  let state = emptyState;
  let active = false;
  let generation = 0;
  const listeners = new Set<() => void>();

  function publish(next: MutationState) {
    state = next;
    for (const listener of listeners) listener();
  }

  function message(key: string, value: SavedItemMessage) {
    const entries = Object.entries(state.messages).filter(([existing]) => existing !== key);
    publish({ ...state, messages: Object.fromEntries([...entries, [key, value]].slice(-SAVED_ITEM_MESSAGE_LIMIT)) });
  }

  async function run(kind: SavedItemKind, id: string, saved: boolean): Promise<void> {
    if (!active) return;
    const key = savedItemKey(kind, id);
    if (Object.hasOwn(state.pending, key)) return;
    const epoch = generation;
    const current = () => active && generation === epoch;
    const contract = kind === "repack" ? savedCatalogItemsV1Contract.setSavedRepack : savedCatalogItemsV1Contract.setSavedCollectible;
    const input = kind === "repack" ? { publicRepackId: id, saved } : { publicCollectibleId: id, saved };
    const parsed = contract.input.safeParse(input);
    if (!parsed.success || Object.keys(state.pending).length >= MAX_PENDING) {
      message(key, presentSavedItemMutationMessage({ kind, saved: !saved, outcome: "error", errorCode: parsed.success ? null : kind === "repack" ? "INVALID_PUBLIC_REPACK_ID" : "INVALID_PUBLIC_COLLECTIBLE_ID" }));
      return;
    }
    id = "publicRepackId" in parsed.data ? parsed.data.publicRepackId : parsed.data.publicCollectibleId;
    const messages = { ...state.messages };
    delete messages[key];
    publish({ ...state, pending: { ...state.pending, [key]: saved }, messages });
    try {
      const raw = kind === "repack"
        ? await ports.setSavedRepack({ publicRepackId: id, saved })
        : await ports.setSavedCollectible({ publicCollectibleId: id, saved });
      if (!current()) return;
      const parsedResult = contract.output.safeParse(raw);
      if (!parsedResult.success) throw refusal("SAVED_ITEMS_STATE_CONFLICT");
      const result = parsedResult.data;
      if ("code" in result) throw refusal(result.code);
      publish({ ...state, refusedAsSuspended: false });

      // Convex resolves a mutation after subscribed queries update. Re-read and validate the
      // bounded set before announcing success, including every same-kind capacity prune.
      const ids = savedCatalogItemIdsSchema.safeParse(await ports.getSavedItemIds().catch(() => { throw refusal("SAVED_ITEMS_STATE_CONFLICT"); }));
      if (!current()) return;
      if (!ids.success) throw refusal("SAVED_ITEMS_STATE_CONFLICT");
      const actual = (kind === "repack" ? ids.data.savedRepackIds : ids.data.savedCollectibleIds).includes(id);
      if (actual !== result.saved || (result.prunedUnavailable && !result.saved)) {
        throw refusal("SAVED_ITEMS_STATE_CONFLICT");
      }
      message(key, presentSavedItemMutationMessage({ kind, saved: result.saved, outcome: "success", prunedUnavailable: result.prunedUnavailable }));
    } catch (error) {
      if (!current()) return;
      if (isSuspendedAccountRefusal(error)) publish({ ...state, refusedAsSuspended: true });
      message(key, presentSavedItemMutationMessage({ kind, saved: !saved, outcome: "error", errorCode: readRefusalCode(error) }));
    } finally {
      if (current()) {
        const pending = { ...state.pending };
        delete pending[key];
        publish({ ...state, pending });
      }
    }
  }

  return {
    run,
    activate() { active = true; },
    dispose() { active = false; generation += 1; publish(emptyState); },
    getSnapshot: () => state,
    getServerSnapshot: () => emptyState,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
