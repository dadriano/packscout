# 002 — Add the approved admin UX and copy

**Status:** todo

## Done when

- The source create and edit forms use a labelled numeric field named
  `Maximum records per request`, with range 1–5,000 and default 500.
- The associated helper says exactly: `Smaller values use less memory. Larger
  values can finish backfills faster. The source may return fewer.`
- Invalid input says exactly: `Enter a whole number from 1 to 5,000.`
- A valid save announces exactly: `Saved. Applies to the next import run.`
- The source overview and detail display the configured value for administrators
  and data operators without an inline overview editor.
- If active queued or running work has another pin, the display uses actual
  values in `Current run: 500. Next run: 1,000.` format.
- Field help, error, and live save status are accessible and do not rely on color.

## Test map

- Component/page tests for default, valid save, invalid value, permissions,
  read-only display, and current/next copy.
- Browser smoke for create/edit and read-only overview/detail at a desktop viewport.

