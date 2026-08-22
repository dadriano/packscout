import {
  ACCESS_HOLDING_COPY,
  type AccessHoldingReason,
} from "@/lib/access-holding-content";

/**
 * The holding surface's placeholder rendering (closed-beta-access/007).
 *
 * It renders entirely from the reason the gate resolved — awaiting review,
 * declined, suspended, or the fail-closed undetermined state — with no
 * catalog read, no authenticated read, and no authenticated capability. The
 * shell around it wears the gateway face, whose account menu carries the
 * sign-out affordance every state points at.
 *
 * closed-beta-access/008 replaces this component in place: same route, same
 * reason prop, plus the verified identity display, the live reaction to
 * decision changes, and the contact path.
 */
export function AccessHoldingNotice({
  reason,
}: Readonly<{ reason: AccessHoldingReason }>) {
  const copy = ACCESS_HOLDING_COPY[reason];
  return (
    <section
      aria-labelledby="access-holding-heading"
      className="route-placeholder"
    >
      <div className="route-placeholder__inner">
        <p className="route-kicker">{copy.kicker}</p>
        <h1
          className="route-title"
          data-route-heading
          id="access-holding-heading"
          tabIndex={-1}
        >
          {copy.heading}
        </h1>
        <p className="route-copy">{copy.body}</p>
        <p className="route-copy">{copy.accountNote}</p>
        {copy.retry ? (
          <a className="route-action" href={copy.retry.href}>
            {copy.retry.label}
          </a>
        ) : null}
      </div>
    </section>
  );
}
