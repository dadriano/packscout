"use client";

import {
  type DragEvent,
  type FocusEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { PackScoutAuthStatus } from "@/components/auth/AuthContext.client";
import type {
  TableColumnLayoutPersistence,
  TableColumnLayoutSaveState,
} from "@/components/table-layout/TableColumnLayoutContext.client";
import { positionGlossaryPanel } from "@/lib/glossary-hint.client";
import type { TableColumnLayoutSummary } from "@/lib/table-column-layout";
import {
  COLUMN_LAYOUT_PANEL_HINT,
  COLUMN_LAYOUT_RESET_ANNOUNCEMENT,
  droppedColumnIndex,
  presentColumnLayoutPersistence,
  presentColumnLayoutTrigger,
  presentColumnMoveAnnouncement,
  presentColumnVisibilityAnnouncement,
} from "./column-layout-presentation";
import styles from "./ColumnLayoutControl.module.css";

export type ColumnLayoutControlColumn = Readonly<{
  key: string;
  label: string;
  required: boolean;
  visible: boolean;
}>;

type ColumnLayoutControlProps = Readonly<{
  columns: readonly ColumnLayoutControlColumn[];
  summary: TableColumnLayoutSummary;
  persistence: TableColumnLayoutPersistence;
  authStatus: PackScoutAuthStatus;
  loading: boolean;
  saveState: TableColumnLayoutSaveState;
  onSetVisible: (key: string, visible: boolean) => void;
  onMove: (key: string, toIndex: number) => void;
  onReset: () => void;
  onSignIn: () => void;
}>;

type DropTarget = Readonly<{ index: number; before: boolean }>;

function ColumnsIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 16 16" width="14">
      <rect height="11.5" rx="1.6" stroke="currentColor" strokeWidth="1.35" width="12.5" x="1.75" y="2.25" />
      <path d="M6.1 2.5v11M9.9 2.5v11" stroke="currentColor" strokeWidth="1.35" />
    </svg>
  );
}

function GripIcon() {
  return (
    <svg aria-hidden="true" fill="currentColor" height="12" viewBox="0 0 8 12" width="8">
      <circle cx="2" cy="2" r="1.1" />
      <circle cx="6" cy="2" r="1.1" />
      <circle cx="2" cy="6" r="1.1" />
      <circle cx="6" cy="6" r="1.1" />
      <circle cx="2" cy="10" r="1.1" />
      <circle cx="6" cy="10" r="1.1" />
    </svg>
  );
}

function ArrowIcon({ direction }: Readonly<{ direction: "up" | "down" }>) {
  return (
    <svg aria-hidden="true" fill="none" height="12" viewBox="0 0 12 12" width="12">
      <path
        d={direction === "up" ? "M2.5 7.5 6 4l3.5 3.5" : "M2.5 4.5 6 8l3.5-3.5"}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

export function ColumnLayoutControl({
  columns,
  summary,
  persistence,
  authStatus,
  loading,
  saveState,
  onSetVisible,
  onMove,
  onReset,
  onSignIn,
}: ColumnLayoutControlProps) {
  const reactId = useId();
  const panelId = `${reactId.replaceAll(":", "")}-columns`;
  const hintId = `${panelId}-hint`;
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const handleRefs = useRef(new Map<string, HTMLButtonElement>());
  const trigger = presentColumnLayoutTrigger(summary);
  const persistencePresentation = presentColumnLayoutPersistence({
    persistence,
    authStatus,
    loading,
    saveState,
  });

  useEffect(() => {
    if (!open) return;
    function closeOnOutsidePress(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;

    function placePanel() {
      const anchor = triggerRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      const position = positionGlossaryPanel({
        align: "end",
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        trigger: anchor.getBoundingClientRect(),
        panelWidth: panel.offsetWidth,
        panelHeight: panel.offsetHeight,
      });
      panel.style.insetInlineStart = `${position.left}px`;
      panel.style.insetBlockStart = `${position.top}px`;
      panel.style.visibility = "visible";
    }

    placePanel();
    panelRef.current?.focus({ preventScroll: true });
    window.addEventListener("resize", placePanel);
    window.addEventListener("scroll", placePanel, true);
    return () => {
      window.removeEventListener("resize", placePanel);
      window.removeEventListener("scroll", placePanel, true);
    };
  }, [open, columns.length]);

  function close(returnFocus: boolean) {
    setOpen(false);
    setDragKey(null);
    setDropTarget(null);
    if (returnFocus) triggerRef.current?.focus();
  }

  function handleRootKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  }

  function handleRootBlur(event: FocusEvent<HTMLDivElement>) {
    if (
      open &&
      event.relatedTarget instanceof Node &&
      !event.currentTarget.contains(event.relatedTarget)
    ) {
      setOpen(false);
    }
  }

  function move(column: ColumnLayoutControlColumn, toIndex: number) {
    const bounded = Math.max(0, Math.min(toIndex, columns.length - 1));
    const fromIndex = columns.findIndex(({ key }) => key === column.key);
    if (bounded === fromIndex) return;
    onMove(column.key, bounded);
    setAnnouncement(
      presentColumnMoveAnnouncement(column.label, bounded + 1, columns.length),
    );
  }

  // A move button that reaches the edge becomes disabled and would drop focus
  // to the document; the row's handle keeps the keyboard inside the panel.
  function moveFromButton(
    column: ColumnLayoutControlColumn,
    toIndex: number,
    direction: "up" | "down",
  ) {
    const reachesEdge =
      direction === "up" ? toIndex <= 0 : toIndex >= columns.length - 1;
    if (reachesEdge) handleRefs.current.get(column.key)?.focus();
    move(column, toIndex);
  }

  function reset() {
    // The Reset button unmounts once the layout is default again.
    panelRef.current?.focus({ preventScroll: true });
    onReset();
    setAnnouncement(COLUMN_LAYOUT_RESET_ANNOUNCEMENT);
  }

  function handleHandleKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    column: ColumnLayoutControlColumn,
    index: number,
  ) {
    const targetIndex =
      event.key === "ArrowUp"
        ? index - 1
        : event.key === "ArrowDown"
          ? index + 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? columns.length - 1
              : null;
    if (targetIndex === null) return;
    event.preventDefault();
    move(column, targetIndex);
  }

  function handleDragStart(event: DragEvent<HTMLLIElement>, column: ColumnLayoutControlColumn) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", column.key);
    setDragKey(column.key);
  }

  function handleDragOver(event: DragEvent<HTMLLIElement>, index: number) {
    if (dragKey === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const bounds = event.currentTarget.getBoundingClientRect();
    const before = event.clientY < bounds.top + bounds.height / 2;
    if (dropTarget?.index !== index || dropTarget.before !== before) {
      setDropTarget({ index, before });
    }
  }

  function handleDrop(event: DragEvent<HTMLLIElement>) {
    event.preventDefault();
    const column = columns.find(({ key }) => key === dragKey);
    if (column && dropTarget) {
      move(
        column,
        droppedColumnIndex({
          fromIndex: columns.indexOf(column),
          targetIndex: dropTarget.index,
          before: dropTarget.before,
        }),
      );
    }
    setDragKey(null);
    setDropTarget(null);
  }

  function endDrag() {
    setDragKey(null);
    setDropTarget(null);
  }

  return (
    <div
      className={styles.root}
      onBlur={handleRootBlur}
      onKeyDown={handleRootKeyDown}
      ref={rootRef}
    >
      <button
        aria-controls={panelId}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={trigger.accessibleLabel}
        className={styles.trigger}
        data-customized={trigger.customized ? "true" : "false"}
        onClick={() => (open ? close(false) : setOpen(true))}
        ref={triggerRef}
        type="button"
      >
        <ColumnsIcon />
        <span>{trigger.label}</span>
        {trigger.detail ? (
          <span className={styles.detail}>{trigger.detail}</span>
        ) : null}
      </button>

      {open ? (
        <div
          aria-describedby={hintId}
          aria-label="Table columns"
          className={styles.panel}
          id={panelId}
          ref={panelRef}
          role="dialog"
          tabIndex={-1}
        >
          <p className={styles.hint} id={hintId}>
            {COLUMN_LAYOUT_PANEL_HINT}
          </p>
          <ul className={styles.list}>
            {columns.map((column, index) => (
              <li
                className={styles.item}
                data-dragging={dragKey === column.key ? "true" : "false"}
                data-drop={
                  dropTarget?.index === index
                    ? dropTarget.before
                      ? "before"
                      : "after"
                    : undefined
                }
                data-hidden={column.visible ? "false" : "true"}
                draggable={!loading}
                key={column.key}
                onDragEnd={endDrag}
                onDragOver={(event) => handleDragOver(event, index)}
                onDragStart={(event) => handleDragStart(event, column)}
                onDrop={handleDrop}
              >
                <button
                  aria-label={`Move ${column.label}. Press the arrow keys to reorder.`}
                  className={styles.handle}
                  disabled={loading}
                  onKeyDown={(event) => handleHandleKeyDown(event, column, index)}
                  ref={(element) => {
                    if (element) handleRefs.current.set(column.key, element);
                    else handleRefs.current.delete(column.key);
                  }}
                  type="button"
                >
                  <GripIcon />
                </button>
                <label className={styles.option}>
                  <input
                    checked={column.visible}
                    disabled={column.required || loading}
                    onChange={(event) => {
                      onSetVisible(column.key, event.currentTarget.checked);
                      setAnnouncement(
                        presentColumnVisibilityAnnouncement(
                          column.label,
                          event.currentTarget.checked,
                        ),
                      );
                    }}
                    type="checkbox"
                  />
                  <span className={styles.optionLabel}>{column.label}</span>
                  {column.required ? (
                    <span className={styles.required}>Always shown</span>
                  ) : null}
                </label>
                <span className={styles.moveButtons}>
                  <button
                    aria-label={`Move ${column.label} up`}
                    className={styles.moveButton}
                    disabled={loading || index === 0}
                    onClick={() => moveFromButton(column, index - 1, "up")}
                    type="button"
                  >
                    <ArrowIcon direction="up" />
                  </button>
                  <button
                    aria-label={`Move ${column.label} down`}
                    className={styles.moveButton}
                    disabled={loading || index === columns.length - 1}
                    onClick={() => moveFromButton(column, index + 1, "down")}
                    type="button"
                  >
                    <ArrowIcon direction="down" />
                  </button>
                </span>
              </li>
            ))}
          </ul>
          <div className={styles.footer}>
            <p className={styles.persistence} data-tone={persistencePresentation.tone}>
              <span>{persistencePresentation.message}</span>
              {persistencePresentation.action === "login" ? (
                <button className={styles.linkButton} onClick={onSignIn} type="button">
                  {persistencePresentation.actionLabel}
                </button>
              ) : null}
            </p>
            {summary.customized ? (
              <button
                className={styles.reset}
                disabled={loading}
                onClick={reset}
                type="button"
              >
                Reset
              </button>
            ) : null}
          </div>
          <p aria-live="polite" className="sr-only" role="status">
            {announcement}
          </p>
        </div>
      ) : null}
    </div>
  );
}
