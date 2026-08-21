/**
 * Opaque handles for product-user detail routes.
 *
 * A subject key is issuer-qualified personal data. A URL is not a private
 * channel: it reaches browser history, server access logs, same-origin
 * referrers, and the sign-in `returnTo` query. So the detail route carries a
 * handle instead — a random value with no derivation from the subject and no
 * meaning outside this tab — while the subject itself continues to travel only
 * in POST bodies.
 *
 * The mapping is held in memory and nowhere else. Nothing is written to any
 * store the browser keeps, matching the `no-store` the directory routes set on
 * every response that carries a person. A handle the tab did not issue — a
 * pasted link, a restored tab, a reload — therefore resolves to nothing, and
 * the detail view says so rather than guessing at who was meant.
 */

/** Handles retained at once, so a long paging session stays bounded. */
const MAX_RETAINED_HANDLES = 500;

const subjectsByHandle = new Map<string, string>();
const handlesBySubject = new Map<string, string>();

function opaqueHandle(): string {
  // Random bytes, not a digest of the subject: a handle must not be reversible
  // and must not correlate two visits to the same person.
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function evictOldest(): void {
  while (subjectsByHandle.size > MAX_RETAINED_HANDLES) {
    const oldest = subjectsByHandle.keys().next();
    if (oldest.done) return;
    const subject = subjectsByHandle.get(oldest.value);
    subjectsByHandle.delete(oldest.value);
    if (subject !== undefined && handlesBySubject.get(subject) === oldest.value) {
      handlesBySubject.delete(subject);
    }
  }
}

/**
 * The handle for one subject, stable for as long as this tab holds it, so a
 * row that re-renders keeps the same link rather than churning history.
 */
export function productUserHandle(subject: string): string {
  const existing = handlesBySubject.get(subject);
  if (existing !== undefined) return existing;
  const handle = opaqueHandle();
  handlesBySubject.set(subject, handle);
  subjectsByHandle.set(handle, subject);
  evictOldest();
  return handle;
}

/** The subject a handle stands for, or null when this tab never issued it. */
export function resolveProductUserHandle(handle: string): string | null {
  return subjectsByHandle.get(handle) ?? null;
}

/** Test seam: drops every handle this tab has issued. */
export function forgetProductUserHandles(): void {
  subjectsByHandle.clear();
  handlesBySubject.clear();
}
