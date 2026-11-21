# Cloud Build source

`develop.ts` owns the configuration consumed by the existing develop trigger at
`cloudbuild.yaml`. Run `npm run ci:cloudbuild` after editing its TypeScript source.
`npm run ci:cloudbuild:check` checks byte-for-byte drift without writing files;
`ci:check` includes that command automatically. The current trigger and its
Terraform configuration are owned by the same generated-artifact check.

`production.ts` owns the existing production trigger artifact at
`cloudbuild-prod.yaml`. The frozen fixture test checks the pre-migration configuration except for the
explicitly tested typed push-token and notification Scheduler adapters. Those
adapters preserve deployment dependencies, schedules, OIDC targets, substitutions,
and secret bindings. Production changes go through the same write and drift-check
commands. The production trigger
itself remains outside Terraform.

`testflightFeedback.ts` owns `ci/generated/cloudbuild/testflight-feedback.yaml`. Its steps
build and deploy the feedback-sync Cloud Run Job; the prerequisite scheduler
bootstrap remains `scripts/deploy-testflight-feedback-scheduler.sh`. The same
write and check commands generate and verify this Cloud Build artifact.

`observabilityAlerts.ts` owns `cloudbuild-observability-alerts.yaml`. It builds
an immutable-tagged image only; deployment still requires a separately verified
image digest. The generator checks this artifact for drift with the others.

`trigger.ts` owns the develop and production web-deploy trigger's ignored-file
policy. `npm run ci:cloudbuild` generates the Terraform input at
`terraform/platform/generated-cloud-build-ignored-files.json`; the check rejects
drift. Apply the Terraform plan after merging a filter change so Cloud Build
uses the new policy. CI-only and iOS-only commits then avoid the full web build,
while changes to `ci/cloudbuild/**` and all other unlisted paths still deploy.

The develop build does not run lint. PR Checks' required `Lint changed code`
validates each change before it reaches develop; the merge queue is currently
disabled.
Generated-type drift, chat type parity, coverage and the container tests still
gate `push-runtime`.

The structural types check step fields, the declared step ID vocabulary,
dependency references, environment assignment syntax, durations, options, and
substitution keys. Before rendering, the generator rejects duplicate IDs,
missing/forward/self dependencies, mixed start markers, and undeclared or
duplicate secret environment names. Omitting `waitFor` retains Cloud Build's
implicit dependency on all prior steps; `['-']` retains immediate scheduling.
The frozen pre-migration fixture tests emitter roundtrip compatibility. The drift
check compares the current typed definition with its generated output; intentional
configuration changes do not require rewriting the historical fixture.

## Remaining execution work

This is a typed configuration, not a fully typed deployment implementation.
`runtime/stagingDeployFlags.ts` owns staging secret references and all-or-none optional groups. A bounded Node preparation step probes access with four workers and writes a reference-only JSON flags file consumed by native `gcloud run deploy`; it never reads or persists secret payloads. The superseded staging Bash body is removed. Cache pulls use native Docker arguments and Cloud Build `allowFailure`; a missing cache remains visible as a failed optional step while image construction and every validation/publication step stay required.
The referenced Bash scripts, command-line arguments, substitution
interpolation, and remote API responses are not type-checked by this schema.
Promotion and health verification now run in native TypeScript. Promotion preserves
the trigger ownership, latest candidate, and service etag guards, then waits for
the returned Cloud Run operation to complete within 300 seconds. Health verification
uses a separate 120-second monotonic deadline, including request time, rather than
24 two-second sleeps. Both phases recheck supersession while waiting. Each HTTP
request is bounded by the smaller of ten seconds and the remaining deadline.
Operation errors, malformed responses, missing ownership, and wrong revisions fail
closed. The build service account token stays in memory. Validation gates, cache,
migrations, secret binding, and publication behavior are unchanged. The production
build's push-token cleanup scheduler now shares the typed
`reconcilePushTokenCleanupScheduler.ts` runtime with staging. Notification, push-token, Plaid webhook and Plaid sync jobs share `schedulerRuntime.ts` for metadata credentials,
bounded API calls, idempotent create/update and applied-state verification.
`reconcileNotificationSchedulers.ts` owns the three native worker timers; their
schedules, OIDC identity and deadline are unchanged and the shell owner is removed.
Cloud Build has no resource-upsert step; this deployment adapter reads the live
Cloud Run URL and confirms Scheduler state. Terraform currently owns none of these
jobs; a future IaC ownership transfer must remove the adapter rather than add a second writer. `cloudbuild-plaid-sync.yaml` is generated
from `plaidSync.ts`; its Cloud Run IAM binding is a declarative `gcloud` argument
list, and `reconcilePlaidSyncScheduler.ts` owns the Cloud Scheduler create/update
definition; the shared runtime owns its create/update and applied-state verification.
OIDC service targets and the OAuth Cloud Run Job target remain distinct typed
contracts. Native retry and deadline defaults are only patched when explicitly
owned by that job definition. The frozen fixtures record the old
implementations; they are not editable configuration sources.

The first develop step now checks trigger ownership in the same tested TypeScript
used before candidate creation and traffic promotion. A queued build already
superseded when it starts exits before dependency installation and image work.
An older build that is already running can still do work until its next ownership
check; cancelling that build on arrival of a newer one requires separate
Cloud Build cancellation authority. Source-equivalence decisions are not yet
implemented.
Any runtime skip must prove equivalence against the deployed revision (including
accumulated undeployed product changes), retain required PR validation, and keep
unknown/product/build/dependency/infrastructure changes on the full path. Preserve
the final ownership and traffic guards because an early check cannot prevent a
newer build arriving later. Trigger filtering, if needed, must be reviewed and
applied through its existing Terraform ownership rather than changed ad hoc.

Cloud Run API contracts: [service patch](https://cloud.google.com/run/docs/reference/rest/v2/projects.locations.services/patch) returns an operation; [operation get](https://cloud.google.com/run/docs/reference/rest/v2/projects.locations.operations/get) polls its completion.

Authentication uses the documented [Cloud Build metadata token endpoint](https://docs.cloud.google.com/docs/authentication/rest#metadata-server). Build ownership queries use the supported [`create_time` filter](https://docs.cloud.google.com/build/docs/view-build-results#filter_build_results_by_using_queries) and follow pagination.
