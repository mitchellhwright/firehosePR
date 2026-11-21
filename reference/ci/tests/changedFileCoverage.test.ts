import assert from 'node:assert/strict';
import test from 'node:test';
import { decideChangedFileCoverage } from '../src/ios/changedFileCoverage.ts';

test('one mapped file cannot conceal an unmapped native source file', () => {
  assert.throws(() => decideChangedFileCoverage([
    {
      path: 'ios/example-iosTests/ProfilePhotoViewModelTests.swift',
      owner: 'native',
      selectedIdentifiers: ['example-iosTests/ProfilePhotoViewModelTests'],
    },
    {
      path: 'ios/example-ios/UI/CompletelyUnmappedSurface.swift',
      owner: 'native',
      selectedIdentifiers: [],
      reason: 'no CI test matched ios/example-ios/UI/CompletelyUnmappedSurface.swift',
    },
  ]), /Cannot select iOS tests for ios\/example-ios\/UI\/CompletelyUnmappedSurface.swift: no CI test matched/);
});

test('external journeys and workflow contracts retain their separate owners', () => {
  assert.equal(decideChangedFileCoverage([
    { path: 'ios/example-iosUITests/ChatPlaidLinkE2ETests.swift', owner: 'external-e2e', selectedIdentifiers: [] },
    { path: 'ci/src/actions/ios/validateChatPlaidE2eLog.ts', owner: 'workflow', selectedIdentifiers: [] },
  ]).mode, 'skip');
  assert.equal(decideChangedFileCoverage([
    { path: 'ios/example-iosTests/ProfilePhotoViewModelTests.swift', owner: 'native', selectedIdentifiers: ['example-iosTests/ProfilePhotoViewModelTests'] },
    { path: 'ios/example-iosUITests/ChatPlaidLinkE2ETests.swift', owner: 'external-e2e', selectedIdentifiers: [] },
  ]).mode, 'affected');
});

const unprovableGeneratedModel = {
  path: 'ios/example-ios/Models/Generated/ChatTypes.generated.swift',
  owner: 'native',
  selectedIdentifiers: [],
  reason: 'ios/example-ios/Models/Generated/ChatTypes.generated.swift: changed declarations could not be proven',
  escalation: 'unprovable-generated-model',
} as const;

test('an unprovable generated model escalates to the full native suite with its reason', () => {
  assert.deepEqual(decideChangedFileCoverage([
    unprovableGeneratedModel,
    { path: 'ios/example-iosTests/ProfilePhotoViewModelTests.swift', owner: 'native', selectedIdentifiers: ['example-iosTests/ProfilePhotoViewModelTests'] },
  ]), {
    mode: 'full',
    reason: 'full: generated model change not provable: '
      + 'ios/example-ios/Models/Generated/ChatTypes.generated.swift: changed declarations could not be proven',
  });
});

test('escalation never absorbs an unaccounted file that is not an unprovable generated model', () => {
  assert.throws(() => decideChangedFileCoverage([
    unprovableGeneratedModel,
    {
      path: 'ios/example-ios/UI/CompletelyUnmappedSurface.swift',
      owner: 'native',
      selectedIdentifiers: [],
      reason: 'no CI test matched ios/example-ios/UI/CompletelyUnmappedSurface.swift',
    },
  ]), /Cannot select iOS tests for ios\/example-ios\/UI\/CompletelyUnmappedSurface.swift/);
});

const linkKitPackage = {
  path: 'ios/Packages/PlaidLink/Package.swift',
  owner: 'native',
  selectedIdentifiers: [],
  reason: 'ios/Packages/PlaidLink/Package.swift: the vendored package links into the app binary',
  escalation: 'linked-native-dependency',
} as const;

test('a changed linked native dependency escalates to the full native suite with its reason', () => {
  assert.deepEqual(decideChangedFileCoverage([linkKitPackage]), {
    mode: 'full',
    reason: 'full: linked native dependency changed: '
      + 'ios/Packages/PlaidLink/Package.swift: the vendored package links into the app binary',
  });
});

test('every escalation kind is named in the full-suite reason', () => {
  assert.equal(decideChangedFileCoverage([linkKitPackage, unprovableGeneratedModel]).reason,
    'full: generated model change not provable: '
      + 'ios/example-ios/Models/Generated/ChatTypes.generated.swift: changed declarations could not be proven; '
      + 'linked native dependency changed: '
      + 'ios/Packages/PlaidLink/Package.swift: the vendored package links into the app binary');
});

test('a linked dependency escalation never absorbs an unmapped native source file', () => {
  assert.throws(() => decideChangedFileCoverage([
    linkKitPackage,
    {
      path: 'ios/example-ios/UI/CompletelyUnmappedSurface.swift',
      owner: 'native',
      selectedIdentifiers: [],
      reason: 'no CI test matched ios/example-ios/UI/CompletelyUnmappedSurface.swift',
    },
  ]), /Cannot select iOS tests for ios\/example-ios\/UI\/CompletelyUnmappedSurface.swift/);
});
