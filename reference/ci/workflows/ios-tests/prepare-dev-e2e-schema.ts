import {
  ciEventCondition, concat, expr, github, runner, typedJob, typedStep,
} from '../lib/index.ts';
import { iosChangeGate } from './ios-change-gate.ts';
import { CHECKOUT, iosGateOutput, schemaLane, setupNode, iosControlRunner } from './shared.ts';

/**
 * Check the shared development database before a Mac E2E lane discovers it.
 *
 * The real-server E2E lanes run against one development database that every
 * branch shares, so a branch whose migrations have not merged yet fails
 * somewhere deep inside an XCUITest with a message about a missing column.
 * This job asks the same question on Linux, in a couple of minutes, before
 * any Mac is allocated, and answers it in terms of the migration that is
 * missing rather than the screen that could not load.
 *
 * Nothing here runs the branch's own code: the verifier is the reviewed base
 * copy, the branch contributes migrations that are read as data, and the
 * Cloud SQL credential is issued only after the install that could have run a
 * lifecycle hook is already done.
 */

/** Where the reviewed verifier lands, beside the branch checkout rather than over it. */
const TRUSTED_VERIFIER = 'trusted-verifier';

/** Where the branch's migrations land, read as data and never executed from. */
const PR_SOURCE = 'pr-source';

/** The manifest the materialise step writes and the revision check reads back. */
const MIGRATIONS_MANIFEST = concat(
  runner('temp'),
  '/example-e2e-required-migrations-',
  github('run_id'),
  '.json',
);

/** True only once the base branch carries the revision verifier; see the step below. */
const REVISION_VERIFIER_AVAILABLE = expr(
  "steps.trusted-schema-revision-verifier.outputs.available == 'true'",
);

const checkoutExactE2eRevision = typedStep({
  name: 'Checkout exact E2E revision as data',
  doc: {
    purpose: 'Materialises the head revision migrations, which this job reads as data and never runs.',
    recovery: 'retry; a repeated failure is a GitHub or runner network problem',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  uses: CHECKOUT,
  with: {
    path: PR_SOURCE,
    'persist-credentials': false,
    ref: expr('env.EXAMPLE_CI_EXACT_HEAD_SHA'),
    // Only the migrations are read from this checkout.
    'sparse-checkout': 'server/db',
  },
});

const checkoutTrustedSchemaVerifier = typedStep({
  name: 'Checkout trusted schema verifier',
  doc: {
    purpose: 'Materialises the reviewed base workspace the schema verification itself is run from.',
    recovery: 'retry; a repeated failure is a GitHub or runner network problem',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  uses: CHECKOUT,
  with: {
    path: TRUSTED_VERIFIER,
    'persist-credentials': false,
    ref: iosGateOutput('verifier_sha'),
  },
});

const verifyTrustedVerifierRevision = typedStep({
  name: 'Verify trusted schema verifier revision',
  doc: {
    purpose: 'Confirms the verifier about to run is the reviewed base copy rather than the branch one.',
    recovery: 'read the revision the step prints; a mismatch means the trusted checkout did not land',
  },
  owner: 'infrastructure',
  category: 'quality',
  unit: 'step',
  env: {
    TRUSTED_CHECKOUT_PATH: TRUSTED_VERIFIER,
    TRUSTED_VERIFIER_SHA: iosGateOutput('verifier_sha'),
  },
  command: 'node trusted-verifier/ci/src/actions/ios/verifyTrustedSchemaVerifierRevision.ts',
});

/**
 * Authentication deliberately happens after installation. Pull-request
 * lifecycle hooks therefore never receive the Cloud SQL credential.
 */
const installVerifierDependencies = typedStep({
  name: 'Install schema-verification dependencies',
  doc: {
    purpose: 'Installs the verifier dependencies while no database credential exists on the runner yet.',
    recovery: 'read the npm log; a lockfile conflict is fixed in the branch, a registry error retried',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  workingDirectory: TRUSTED_VERIFIER,
  command: 'npm ci --ignore-scripts --no-audit --no-fund --prefer-offline',
});

/**
 * The revision verifier itself lands on the base branch through this change.
 * Until it merges, checking it out at EXAMPLE_CI_TRUSTED_BASE_SHA finds neither
 * script, so the revision check is skipped rather than failed; every pull
 * request after it has a base checkout that includes them.
 */
const checkRevisionVerifierAvailability = typedStep({
  id: 'trusted-schema-revision-verifier',
  name: 'Check trusted schema-revision verifier availability',
  doc: {
    purpose: 'Reports whether the base revision already carries the schema-revision verifier to run.',
    recovery: 'no action while the verifier is still landing on the base branch',
  },
  owner: 'infrastructure',
  category: 'quality',
  unit: 'step',
  outputs: ['available'] as const,
  env: { TRUSTED_CHECKOUT_PATH: TRUSTED_VERIFIER },
  command: 'node trusted-verifier/ci/src/actions/ios/checkSchemaRevisionVerifier.ts',
});

const materializeMigrations = typedStep({
  name: 'Materialize pull-request migrations as inert data',
  doc: {
    purpose: 'Writes the branch migrations into a manifest the verifier reads without executing them.',
    recovery: 'read the manifest path the step prints; a missing migrations directory is a branch problem',
  },
  owner: 'automation',
  category: 'environment',
  unit: 'step',
  if: REVISION_VERIFIER_AVAILABLE,
  workingDirectory: TRUSTED_VERIFIER,
  env: { E2E_REQUIRED_MIGRATIONS_MANIFEST: MIGRATIONS_MANIFEST },
  command: './node_modules/.bin/tsx server/scripts/materializeDevE2eSchemaRevision.ts'
    + ' "$GITHUB_WORKSPACE/pr-source"'
    + ' "$GITHUB_WORKSPACE/pr-source/server/db/migrations"'
    + ' "$E2E_REQUIRED_MIGRATIONS_MANIFEST"',
});

const schemaAuth = typedStep({
  id: 'schema-auth',
  name: 'Authenticate trusted schema verification to GCP',
  doc: {
    purpose: 'Exchanges the run identity for the credential the two schema checks connect to Cloud SQL with.',
    recovery: 'check the workload identity provider still trusts this repository and the service account',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  uses: 'google-github-actions/auth@v3',
  with: {
    project_id: 'example-app',
    workload_identity_provider:
      'projects/123456789012/locations/global/workloadIdentityPools/github-actions/providers/github',
    service_account: 'github-actions-ci@example-app.iam.gserviceaccount.com',
  },
});

/**
 * Revision parity first: a branch that adds migrations cannot run against the
 * shared development database until those migrations merge to the base
 * branch, and the object-level check below is blind to unapplied revisions.
 */
const verifySchemaRevision = typedStep({
  id: 'schema-revision',
  name: 'Verify development E2E schema revision',
  doc: {
    purpose: 'Checks the development database has already applied every migration this branch needs.',
    recovery: 'merge the migrations to the base branch and apply them before rerunning the E2E lanes',
  },
  owner: 'automation',
  category: 'quality',
  unit: 'step',
  if: REVISION_VERIFIER_AVAILABLE,
  continueOnError: true,
  workingDirectory: TRUSTED_VERIFIER,
  env: { E2E_REQUIRED_MIGRATIONS_MANIFEST: MIGRATIONS_MANIFEST },
  command: './node_modules/.bin/tsx server/scripts/verifyDevE2eSchemaRevision.ts',
});

const verifySchemaObjects = typedStep({
  id: 'schema-objects',
  name: 'Verify development E2E schema objects',
  doc: {
    purpose: 'Checks the database objects the real-server E2E lanes read are present and shaped as expected.',
    recovery: 'read the object the step names and apply the migration that creates it',
  },
  owner: 'automation',
  category: 'quality',
  unit: 'step',
  if: "${{ !cancelled() && steps.schema-auth.outcome == 'success' }}",
  continueOnError: true,
  workingDirectory: TRUSTED_VERIFIER,
  command: './node_modules/.bin/tsx server/scripts/verifyPlaidSchedulerSchema.ts',
});

/**
 * Both checks above are advisory so that one failing still lets the other
 * report; this step is where the two outcomes become the single verdict the
 * E2E lanes are gated on.
 */
const enforceSchemaVerification = typedStep({
  name: 'Enforce development E2E schema verification',
  doc: {
    purpose: 'Turns the two advisory schema checks into the one verdict the E2E lanes are gated on.',
    recovery: 'read which of the two checks above failed; this step only reports their outcome',
  },
  owner: 'automation',
  category: 'quality',
  unit: 'step',
  if: '${{ !cancelled() }}',
  env: {
    REVISION_REQUIRED: checkRevisionVerifierAvailability.outputs.available,
    REVISION_OUTCOME: expr('steps.schema-revision.outcome'),
    OBJECT_OUTCOME: expr('steps.schema-objects.outcome'),
  },
  command: 'node trusted-verifier/ci/src/actions/ios/enforceDevE2eSchemaVerification.ts',
});

const removeMigrationManifest = typedStep({
  name: 'Remove migration manifest',
  doc: {
    purpose: 'Removes the migration manifest this job wrote into the runner temporary directory.',
    recovery: 'no action; the manifest expires with the runner temporary directory',
  },
  owner: 'infrastructure',
  category: 'cleanup',
  unit: 'step',
  if: expr('always()'),
  command: 'node trusted-verifier/ci/src/actions/ios/removeMigrationManifest.ts',
});

export const prepareDevE2eSchema = typedJob('prepare-dev-e2e-schema', {
  name: 'Verify development E2E schema',
  doc: {
    purpose: 'Confirms the shared development database matches this branch before an E2E lane runs on it.',
    successMeaning: 'The real-server E2E lanes can trust the schema the development database exposes.',
  },
  owner: 'product',
  category: 'quality',
  unit: 'suite',
  needs: [iosChangeGate],
  if: expr(
    'always() && !cancelled() '
    + "&& ( ( github.event_name == 'workflow_dispatch' "
    + "&& inputs.test_scope == 'development-e2e-schema' ) "
    // A queue candidate that reuses a real-server lane's pull request result
    // runs no lane, but that evidence still depends on this database.
    + "|| needs.ios-change-gate.outputs.real_server_evidence_reused == 'true' "
    + "|| ( needs.ios-change-gate.outputs.should_run == 'true' "
    + "&& ( needs.ios-change-gate.outputs.onboarding_required == 'true' "
    + "|| needs.ios-change-gate.outputs.chat_plaid_required == 'true' "
    + "|| needs.ios-change-gate.outputs.income_required == 'true' "
    + "|| ( needs.ios-change-gate.outputs.budget_required == 'true' "
    + "&& vars.IOS_ENABLE_BUDGET_E2E == 'true' ) "
    + "|| ( github.event_name == 'workflow_dispatch' "
    + "&& ( inputs.test_scope == 'e2e' "
    + "|| inputs.test_scope == 'evidence' "
    + "|| inputs.test_scope == 'debt-card-evidence' ) ) ) ) ) "
    // The database only exists for develop and main, and only a
    // same-repository head (or a develop queue candidate) may reach it.
    + `&& ( ${ciEventCondition('reviewedChangeIntoTarget')} `
    + "|| ( github.event_name == 'workflow_dispatch' "
    + "&& (github.ref == 'refs/heads/develop' || github.ref == 'refs/heads/main') ) )",
  ),
  // Use the gate's admitted Linux route, with its existing external fallback,
  // instead of waiting for a fixed pool after hosted overflow was admitted.
  runsOn: iosControlRunner,
  // Failure bound only (about twice the slowest run observed); nothing inside
  // the job waits on a timer.
  timeoutMinutes: 20,
  permissions: { contents: 'read', 'id-token': 'write' },
  environment: { name: 'development-e2e' },
  lane: schemaLane,
  env: {
    DB_IAM_USER: 'github-actions-ci@example-app.iam',
    DB_NAME: 'example',
    GCP_SERVICE_ACCOUNT: 'github-actions-ci@example-app.iam.gserviceaccount.com',
    GCP_WORKLOAD_IDENTITY_PROVIDER:
      'projects/123456789012/locations/global/workloadIdentityPools/github-actions/providers/github',
    INSTANCE_CONNECTION_NAME: 'example-app:us-central1:example-dev-postgres',
    VERIFY_APPLE_AUTHORIZATION_SCHEMA: 'false',
  },
  steps: [
    checkoutExactE2eRevision,
    checkoutTrustedSchemaVerifier,
    // Node first: every check below this point is a typed program, and the
    // revision check must still run before anything is installed from the
    // checkout it verifies. setup-node runs no repository code.
    setupNode('Set up the Node.js runtime'),
    verifyTrustedVerifierRevision,
    installVerifierDependencies,
    checkRevisionVerifierAvailability,
    materializeMigrations,
    schemaAuth,
    verifySchemaRevision,
    verifySchemaObjects,
    enforceSchemaVerification,
    removeMigrationManifest,
  ],
});
