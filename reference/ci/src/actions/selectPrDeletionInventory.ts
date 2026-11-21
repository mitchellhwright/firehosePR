import { copyFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { selectDeletionInventory } from '../prGateAdapters.ts';
import { appendStepOutputs } from '../ios/shared/githubOutputs.ts';
import { readStepEnvironment } from '../ios/shared/stepEnvironment.ts';

// A failed validation must not leave deletion data from a prior attempt.
const destination = readStepEnvironment(z.object({ DELETED_FILES_FILE: z.string().min(1) }));
writeFileSync(destination.DELETED_FILES_FILE, '');

const flag = z.enum(['true', 'false', '']).default('').transform((value) => value === 'true');
const env = readStepEnvironment(z.object({
  METADATA_ONLY: flag,
  CLASSIFIER_INVENTORY_SELECTED: flag,
  FILE_STATUS_INVENTORY_VERIFIED: flag,
  INCREMENTAL_DELETED_FILES: z.string().default(''),
  DELETED_FILES_INVENTORY_FILE: z.string().min(1),
  DELETED_FILES_FILE: z.string().min(1),
}));
const inventory = selectDeletionInventory({
  metadataOnly: env.METADATA_ONLY,
  classifierSelected: env.CLASSIFIER_INVENTORY_SELECTED,
  inventoryVerified: env.FILE_STATUS_INVENTORY_VERIFIED,
  incrementalDeletedFiles: env.INCREMENTAL_DELETED_FILES,
  inventoryPath: env.DELETED_FILES_INVENTORY_FILE,
});
if (inventory.source === 'pull-request') copyFileSync(inventory.path, env.DELETED_FILES_FILE);
else writeFileSync(env.DELETED_FILES_FILE, inventory.contents);
appendStepOutputs([['file_status_available', 'true']]);
