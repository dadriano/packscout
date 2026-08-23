integration-pass fix list:
- Root loading fallback shows dashboard chrome (h1 'Dashboard' + view nav) to unadmitted visitors before the landing streams in; streamed HTML carries two h1s. Fix: decision-neutral root loading fallback. Found live on the 5197 preview lane, 2026-08-23.
- test:tooling has 2 pre-existing start-admin-embedded failures on the clean base branch (stash-verified by cb/005 builder). verify:framework at integration will hit them — confirm against base, then fix or document before publish.
