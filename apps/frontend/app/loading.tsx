/**
 * The root route resolves the visitor's access decision on the server and then
 * serves one of two entirely different surfaces: the landing page to anyone who
 * is not admitted, the dashboard to anyone who is.
 *
 * This fallback streams before that decision is known, so it must carry no
 * chrome belonging to either answer. Dashboard navigation or a page heading
 * here would flash catalog framing at a signed-out visitor on the product's
 * most-visited URL, and would leave the streamed document with two page
 * headings once the landing page resolved beneath it.
 *
 * Route-specific fallbacks stay with their routes; only the root is ambiguous.
 */
export default function RootLoading() {
  return (
    <div aria-busy="true" className="route-placeholder">
      <p aria-live="polite" className="sr-only" role="status">
        Loading PackScout.
      </p>
    </div>
  );
}
