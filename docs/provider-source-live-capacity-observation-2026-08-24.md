# Provider-source live capacity observation — 2026-08-24

This note records the first real `packscout_dev` ingestion slope. It replaces
the 8.76 TB number as the local operational estimate. That older number assumes
all four sources produce a new 250-record page every minute for an entire year;
it is a transport stress ceiling, not a forecast of provider growth or the
space needed for the current backfill.

## Observed database growth

Both samples were taken from the same migrated PostgreSQL database while the
normal source supervisor imported 250-record pages through the complete
persistence pipeline.

| Committed records | Whole database bytes | Whole database size |
| ---: | ---: | ---: |
| 16,500 | 137,870,359 | 131 MB |
| 20,000 | 162,454,551 | 155 MB |

The 3,500-record interval added 24,584,192 bytes, or **7,024 bytes per
record**. The more conservative whole-database ratio at the second sample is
**8,123 bytes per record** because it also carries fixed schema, run, test, and
diagnostic overhead.

Applying those two observed rates to the dated 14,526,877-record provider
baseline produces a **102.0–118.0 GB** database estimate. Requiring 25% of the
modeled allocation to remain free produces a **136.1–157.3 GB** planning range
(about 127–147 GiB). This is an observed early-run estimate, not a hard upper
bound: PostgreSQL allocation steps, retained raw pages, quarantine mix,
duplicate delivery, provider growth, vacuum, and index growth can move the
final result.

## Runtime decision

Local development therefore does not use the one-year maximum-throughput
stress ceiling as an ongoing admission gate. It keeps an explicit free-space
floor after reserving every already-admitted page and unreconciled attempt.
The current local floor is 16 GiB. Production retains its independent 80%-used
emergency fence until a production capacity policy is approved.

Re-sample the whole database at provider head and after the seven-day raw-page
retention window. Those two measurements should replace this provisional range
for future full-import planning.
