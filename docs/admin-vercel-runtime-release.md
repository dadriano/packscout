# Admin runtime release gate

The admin release gate tests the actual Vercel deployment before Vercel assigns
its production domains. Framework Standards remains a separate CI workflow; this
runtime workflow neither rebuilds the application nor runs the framework suite.

## Release sequence

1. Vercel builds `main` with production configuration and creates a new **Admin
   runtime smoke** check run for that deployment. The check blocks production
   domain assignment while the existing production deployment stays live.
2. `vercel.deployment.ready` triggers `.github/workflows/admin-vercel-release.yml`
   before promotion. Only production events for `packscout-admin` enter its job.
3. The job validates Vercel's deployment metadata: Pack Scout team, admin project,
   this GitHub repository, `main`, and `READY`. It finds the registered check run
   for that exact deployment ID, not a reusable success status on a commit SHA.
4. The read-only probe requests the deployment's immutable URL. It requires the
   `/operations` HTML shell, directly referenced JS/CSS assets, JSON health, and
   unauthenticated session and provider-operations responses. Redirects, missing
   assets, server crashes, and unexpected authorization success fail the check.
   Requests, retries, response sizes, and duration are bounded.
5. The job reports `succeeded` or `failed` to that native Vercel check run. Vercel
   owns production domain assignment after all blocking checks succeed. This
   workflow never calls the promotion API or changes automatic alias settings.

A redeployment of the same commit gets its own run and is tested again. Jobs use
per-deployment concurrency, so unrelated deployment events cannot cancel each
other. Failed or timed-out runs are never rewritten as successful by a retry.

## Configuration

- Project: `packscout-admin`, ID `prj_KR0CnNkPlRgaHRxdPkJh9pVqDGsC`.
- Team: `pack-scout`, ID `team_ZzCQUWPmGibyjlKTAsymGPu1`.
- Native check: `chk_1319f9e5-a77d-4853-95bc-3fc2a64756d8`, **Admin runtime smoke**.
  Configure `source: {kind: "webhook"}`, `requires: "deployment-url"`,
  `blocks: "deployment-alias"`, `targets: ["production"]`, `timeout: 600`.
  No webhook receiver is needed: GitHub repository dispatch starts the reporter.
- Leave automatic production domain assignment enabled. The native check is the
  blocking condition. Do not add Framework Standards as a dependency here.
- Keep Vercel repository-dispatch events enabled. Listen for
  `vercel.deployment.ready`, not the post-promotion success event.
- GitHub environment `admin-runtime-release` allows only branch `main`.
- Environment secret `VERCEL_ADMIN_CHECK_TOKEN` is a Vercel API token scoped to
  this admin project; do not use a personal CLI or team-wide token in the job.
- Environment secret `VERCEL_AUTOMATION_BYPASS_SECRET` bypasses Vercel deployment
  protection only. Packscout application authentication remains enforced.
- The workflow's GitHub token has `contents: read` only. No administrator login,
  database, provider, or import credentials are needed.

The workflow must exist on `main`: GitHub does not run repository-dispatch
workflows that exist only on a feature branch. Configure secrets and the blocking
check before merging the workflow so its first production build is protected.
A missing workflow, missing/expired token, or stalled job cannot report success;
the check fails or times out and leaves the previous release live. Rotate the
project token before its expiration by replacing the GitHub environment secret.
The initially configured token expires November 29, 2026.

## Verification and recovery

Run the standalone read-only probe with an immutable deployment URL in
`PACKSCOUT_ADMIN_DEPLOYMENT_URL` and the optional Vercel bypass secret:

```bash
npm run check:admin-deployment:preproduction
```

For a missed dispatch while the native check is still pending, manually run
**Admin Vercel runtime release** with the candidate's `dpl_...` ID. It applies the
same identity and runtime checks. For a failed or timed-out check, create a new
Vercel deployment; the workflow deliberately preserves terminal conclusions.
Never test the live alias as a substitute for testing the candidate artifact.

Keep the previous release live while fixing a broken candidate. Do not override
or force-promote a failing check. Dashboard or CLI overrides remain privileged
operator actions outside this workflow.

The smoke test checks HTTP startup and delivery, not JavaScript execution in a
browser or authenticated business workflows. It does not isolate build-time
migrations, cron changes, or other deployment side effects.

## Acceptance coverage

| Given / When / Then | Coverage |
| --- | --- |
| A healthy deployment serves the shell, assets, health and auth responses / the probe runs / it passes | `scripts/preproduction/check-admin-vercel.test.mjs`; repaired production artifact probe |
| The deployed server crashes / the probe runs / it fails | Probe behavior tests; historical broken deployment and preview artifact probes |
| A deployment supplies an external URL or asset / the probe runs / no bypass credential is sent off-origin | Probe behavior tests |
| A run belongs to another deployment/project, is missing, ambiguous or terminal / reporting runs / no false success is posted | `scripts/live/report-admin-vercel-check.test.mjs` |
| A new deployment of the same commit is created / reporting runs / only its own check run can succeed | Reporter behavior tests; native preview check creation |
| A built candidate fails / reporting runs / its Vercel check is completed as failed | Reporter behavior tests; native preview API verification |

References: [Vercel Checks v2](https://vercel.com/docs/rest-api/checks-v2/create-a-check),
[check-run reporting](https://vercel.com/docs/rest-api/checks-v2/update-a-check-run),
[repository dispatch](https://vercel.com/docs/git/vercel-for-github#repository-dispatch-events).
