import type { PackScoutAuthStatus } from "@/components/auth/AuthContext.client";
import type {
  TableColumnLayoutPersistence,
  TableColumnLayoutSaveState,
} from "@/components/table-layout/TableColumnLayoutContext.client";
import type { TableColumnLayoutSummary } from "@/lib/table-column-layout";

export type ColumnLayoutTriggerPresentation = Readonly<{
  label: "Columns";
  detail: string | null;
  customized: boolean;
  accessibleLabel: string;
}>;

export function presentColumnLayoutTrigger(
  summary: TableColumnLayoutSummary,
): ColumnLayoutTriggerPresentation {
  const detail = summary.hiddenCount > 0 ? `${summary.hiddenCount} hidden` : null;
  const accessibleLabel = summary.customized
    ? `Columns, ${summary.visibleCount} of ${summary.total} shown${
        summary.reordered ? ", custom order" : ""
      }`
    : "Columns";
  return Object.freeze({
    label: "Columns",
    detail,
    customized: summary.customized,
    accessibleLabel,
  });
}

export type ColumnLayoutPersistencePresentation = Readonly<{
  message: string;
  tone: "neutral" | "positive" | "caution";
  action: "login" | null;
  actionLabel: string | null;
}>;

export function presentColumnLayoutPersistence(input: Readonly<{
  persistence: TableColumnLayoutPersistence;
  authStatus: PackScoutAuthStatus;
  loading: boolean;
  saveState: TableColumnLayoutSaveState;
}>): ColumnLayoutPersistencePresentation {
  if (input.persistence === "account") {
    if (input.loading) {
      return Object.freeze({
        message: "Loading your saved columns…",
        tone: "neutral",
        action: null,
        actionLabel: null,
      });
    }
    if (input.saveState === "saving") {
      return Object.freeze({
        message: "Saving to your account…",
        tone: "neutral",
        action: null,
        actionLabel: null,
      });
    }
    if (input.saveState === "error") {
      return Object.freeze({
        message: "Couldn't save to your account. Try the change again.",
        tone: "caution",
        action: null,
        actionLabel: null,
      });
    }
    return Object.freeze({
      message: "Saved to your account.",
      tone: "positive",
      action: null,
      actionLabel: null,
    });
  }
  const canSignIn = input.authStatus === "signed_out";
  return Object.freeze({
    message: "Kept for this tab only.",
    tone: "neutral",
    action: canSignIn ? "login" : null,
    actionLabel: canSignIn ? "Sign in to keep it" : null,
  });
}

export function presentColumnMoveAnnouncement(
  label: string,
  position: number,
  total: number,
): string {
  return `${label} moved to position ${position} of ${total}.`;
}

export function presentColumnVisibilityAnnouncement(
  label: string,
  visible: boolean,
): string {
  return `${label} column ${visible ? "shown" : "hidden"}.`;
}

export const COLUMN_LAYOUT_RESET_ANNOUNCEMENT =
  "Columns reset to the default layout.";

export const COLUMN_LAYOUT_PANEL_HINT =
  "Show, hide, and drag to reorder. Changes apply right away.";

/**
 * Where a dragged row lands, expressed as the index it occupies once the
 * dragged entry has been removed from its original position.
 */
export function droppedColumnIndex(input: Readonly<{
  fromIndex: number;
  targetIndex: number;
  before: boolean;
}>): number {
  const insertionIndex = input.before ? input.targetIndex : input.targetIndex + 1;
  return input.fromIndex < insertionIndex ? insertionIndex - 1 : insertionIndex;
}
