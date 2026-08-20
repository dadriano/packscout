import { PanelPageHeader } from "../components/PanelShell.tsx";

/**
 * Navigation stub. The database surface arrives with admin-tools/014 (truthful
 * status and a supervised row browser) and admin-tools/015 (guarded
 * operations). Both mount under `/api/database`, which is what places them
 * inside the panel's declared guard membership.
 */
export function DatabasePage() {
  return (
    <>
      <PanelPageHeader
        eyebrow="Database"
        title="Database"
        description="Truthful status, migration state, and guarded operations for the local database."
      />
      <div className="panel-empty-state">
        <h2>Not built yet</h2>
        <p>
          This surface arrives in a later task. When it does, its status reads are
          sensitive reads and its operations are privileged and audited, using the
          same guards this panel already enforces.
        </p>
        <p>
          The panel will never run caller-supplied SQL, paths, or commands. That is
          a permanent design invariant, not a current limitation.
        </p>
      </div>
    </>
  );
}
