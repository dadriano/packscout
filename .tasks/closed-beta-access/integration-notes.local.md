integration-pass fix list:
- Root loading fallback shows dashboard chrome (h1 'Dashboard' + view nav) to unadmitted visitors before the landing streams in; streamed HTML carries two h1s. Fix: decision-neutral root loading fallback. Found live on the 5197 preview lane, 2026-08-23.
- test:tooling has 2 pre-existing start-admin-embedded failures on the clean base branch (stash-verified by cb/005 builder). verify:framework at integration will hit them — confirm against base, then fix or document before publish.
- messaging/012 wiring item: register createEmailLinkTokenPruner (kind email_link_tokens, 30d default) in apps/worker composition — one line left out of msg/008 scope.
- messaging/009: live browser layout pass at 1280/375 in both themes was never run (builder hit a quota limit at that step). Static + structural evidence recorded in its Spec Compliance. Run it during integration if a browser lane is available.
