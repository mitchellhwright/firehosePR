import { developBuild, developStepComments } from '../cloudbuild/develop.ts';
import { cloudBuildInSync, cloudBuildPath, writeCloudBuild } from '../cloudbuild/lib/emit.ts';
import { observabilityAlertsBuild, observabilityAlertsTarget } from '../cloudbuild/observabilityAlerts.ts';
import { plaidSyncBuild, plaidSyncTarget } from '../cloudbuild/plaidSync.ts';
import { productionBuild, productionCloudBuildTarget, productionStepComments } from '../cloudbuild/production.ts';
import { testflightFeedbackBuild, testflightFeedbackTarget } from '../cloudbuild/testflightFeedback.ts';
import { renderWebDeployIgnoredFiles, webDeployIgnoredFilesPath } from '../cloudbuild/trigger.ts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const triggerPath = join(process.cwd(), webDeployIgnoredFilesPath);
const triggerInSync = () => existsSync(triggerPath)
  && readFileSync(triggerPath, 'utf8') === renderWebDeployIgnoredFiles();

switch (process.argv[2]) {
  case 'write':
    writeCloudBuild(process.cwd(), developBuild, developStepComments);
    writeCloudBuild(process.cwd(), productionBuild, productionStepComments, productionCloudBuildTarget);
    writeCloudBuild(process.cwd(), testflightFeedbackBuild, undefined, testflightFeedbackTarget);
    writeCloudBuild(process.cwd(), observabilityAlertsBuild, undefined, observabilityAlertsTarget);
    writeCloudBuild(process.cwd(), plaidSyncBuild, undefined, plaidSyncTarget);
    writeFileSync(triggerPath, renderWebDeployIgnoredFiles());
    console.log(`wrote ${cloudBuildPath}, ${productionCloudBuildTarget.path}, `
      + `${testflightFeedbackTarget.path}, ${observabilityAlertsTarget.path}, ${plaidSyncTarget.path}, `
      + `and ${webDeployIgnoredFilesPath}`);
    break;
  case 'check':
    if (!cloudBuildInSync(process.cwd(), developBuild, developStepComments)) {
      console.error(
        `::error file=${cloudBuildPath}::Generated Cloud Build differs; run npm run ci:cloudbuild and commit the result`
      );
      process.exitCode = 1;
    }
    if (!cloudBuildInSync(process.cwd(), productionBuild, productionStepComments, productionCloudBuildTarget)) {
      console.error(
        `::error file=${productionCloudBuildTarget.path}::Generated production Cloud Build differs; `
        + 'run npm run ci:cloudbuild and commit the result',
      );
      process.exitCode = 1;
    }
    if (!cloudBuildInSync(process.cwd(), testflightFeedbackBuild, undefined, testflightFeedbackTarget)) {
      console.error(
        `::error file=${testflightFeedbackTarget.path}::Generated Cloud Build differs; run npm run ci:cloudbuild and commit the result`,
      );
      process.exitCode = 1;
    }
    if (!cloudBuildInSync(process.cwd(), observabilityAlertsBuild, undefined, observabilityAlertsTarget)) {
      console.error(
        `::error file=${observabilityAlertsTarget.path}::Generated Cloud Build differs; `
        + 'run npm run ci:cloudbuild and commit the result',
      );
      process.exitCode = 1;
    }
    if (!cloudBuildInSync(process.cwd(), plaidSyncBuild, undefined, plaidSyncTarget)) {
      console.error(
        `::error file=${plaidSyncTarget.path}::Generated Cloud Build differs; `
        + 'run npm run ci:cloudbuild and commit the result',
      );
      process.exitCode = 1;
    }
    if (!triggerInSync()) {
      console.error(
        `::error file=${webDeployIgnoredFilesPath}::Generated Cloud Build trigger filters differ; run npm run ci:cloudbuild and commit the result`,
      );
      process.exitCode = 1;
    }
    if (process.exitCode !== 1) {
      console.log('Cloud Build definition, generated YAML, and trigger filters are in sync');
    }
    break;
  default:
    console.error('usage: cloudbuild.ts write|check');
    process.exitCode = 1;
}
