# DataForrest Live Evidence Capture

Use the local capture tool to collect Task 001 contract evidence without
writing the bearer token, raw records, record IDs, or cursors to disk or
stdout.

## Run it

From the repository root, read the token without echoing it, export it only to
the capture process environment, and unset it immediately afterward:

```bash
read -r -s PACKSCOUT_DATA_API_TOKEN
export PACKSCOUT_DATA_API_TOKEN
npm run capture:dataforest-evidence:local > /tmp/packscout-dataforest-evidence.json
unset PACKSCOUT_DATA_API_TOKEN
```

Do not put the token in a command-line argument, shell history, checked-in
environment file, or output filename. The command removes its own inherited
copy of the variable after reading it; the explicit `unset` removes the parent
shell copy.

The endpoint is fixed at
`https://198.204.245.26.sslip.io/v1/events`. The default bounds are 500
records, 2 MiB per response, a 10-second request timeout, and two concurrent
requests. Run `npm run capture:dataforest-evidence:local -- --help` to see
stricter-only overrides.

## What it requests

The tool makes only bounded `GET` requests. With a cursor present for every
platform and the default concurrency, it makes 22 requests; the hard maximum
is 24.

- One authenticated request with no query parameters for the profile-only
  connection probe.
- Initial, continuation, and same-input-cursor replay requests for
  `courtyard`, `collector_crypt`, `phygitals`, and `clutchpacks`.
- Missing-authentication, unknown-filter, malformed-cursor, and four
  cross-filter cursor probes.
- Two to four simultaneous initial filtered requests for bounded overlap and
  cursor-isolation evidence.

Redirects are rejected. The tool stops reading a response at the configured
byte bound and aborts each request at the configured timeout.

## What the report contains

The JSON report contains request categories, safe filter names, HTTP status and
retry classes, latency, byte counts, JSON field paths and types, null and
record counts, structure hashes, cursor relationship booleans, record-identity
comparison counts, and client-side overlap measurements.

It never emits the authorization header, token, cursor value or cursor hash,
record ID, transaction value, wallet, username, provider payload value, raw
body, or raw-body hash. Replay body hashes exist only in memory long enough to
produce an equality boolean.

Review the sanitized JSON before committing any derived fixture. This tool is
capture support only; running it does not complete Task 001 or authorize Task
002.
