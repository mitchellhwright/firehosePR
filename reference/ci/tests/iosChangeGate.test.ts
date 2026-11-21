import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  auxiliaryRerunErrors,
  buildDetectOutputs,
  completeIosChangeDetection,
  detectEarlyExitOutputs,
  forcedLaneFlags,
  nativeSelectorChangedFiles,
  planIosChangeDetection,
  readSelectorDecision,
  selectorDecisionErrors,
  type DetectSelectionPlan,
  type GateContext,
} from '../src/ios/iosChangeGate.ts';
import { StepFailure } from '../src/ios/shared/stepFailure.ts';
import { formatStepOutputs, type StepOutput } from '../src/ios/shared/stepIo.ts';

function context(overrides: Partial<GateContext> = {}): GateContext {
  return {
    forcedIosLanesRaw: '[]',
    reuseNativeEvidenceRaw: 'false',
    changedFilesDelimiter: 'CHANGED_FILES_34933607516_2',
    ...overrides,
  };
}

function values(outputs: readonly StepOutput[]): Record<string, string> {
  return Object.fromEntries(outputs.map((output) => [output.key, output.value]));
}

function selectionPlan(outcome: ReturnType<typeof planIosChangeDetection>): DetectSelectionPlan {
  assert.equal(outcome.kind, 'needs-selectors');
  return outcome as DetectSelectionPlan;
}

describe('buildDetectOutputs', () => {
  it('writes every key the gate reads, in one fixed order', () => {
    const keys = buildDetectOutputs(context(), { shouldRun: 'true', summary: '' })
      .map((output) => output.key);
    assert.deepEqual(keys, [
      'should_run', 'storekit_required', 'onboarding_required', 'budget_required',
      'evidence_required', 'main_required', 'chat_plaid_required', 'income_required',
      'rerun_ios_lanes', 'changed_files', 'native_changed_files',
      'native_changed_files_explicit_empty', 'summary',
    ]);
  });

  it('defaults every unstated lane to false and the inventory to empty', () => {
    const written = values(buildDetectOutputs(context(), { shouldRun: 'false', summary: 'none' }));
    assert.equal(written.storekit_required, 'false');
    assert.equal(written.income_required, 'false');
    assert.equal(written.changed_files, '');
    assert.equal(written.native_changed_files, '');
  });

  it('blanks only the native inventory when retained evidence is reused', () => {
    const written = values(buildDetectOutputs(
      context({ reuseNativeEvidenceRaw: 'true' }),
      { shouldRun: 'true', summary: '', changedFiles: 'ios/a.swift\nios/b.swift' },
    ));
    assert.equal(written.changed_files, 'ios/a.swift\nios/b.swift');
    assert.equal(written.native_changed_files, '');
    assert.equal(written.native_changed_files_explicit_empty, 'true');
  });

  it('preserves income E2E while explicitly emptying its native inventory', () => {
    const path = 'scripts/ios-test-income-e2e.sh';
    const plan = selectionPlan(planIosChangeDetection(context(), {
      eventName: 'merge_group', baseRef: 'develop', changedFiles: path,
      reuseNativeEvidence: 'false',
      forcedIosAuxiliaryRaw: '[]',
    }));
    assert.equal(plan.classification.incomeRequired, true);
    assert.equal(nativeSelectorChangedFiles(path), '');

    const written = values(completeIosChangeDetection(context(), plan, {
      evidenceRequired: false,
      mainRequired: false,
      onboardingRequired: false,
    }, 'false'));
    assert.equal(written.should_run, 'true');
    assert.equal(written.income_required, 'true');
    assert.equal(written.main_required, 'false');
    assert.equal(written.evidence_required, 'false');
    assert.equal(written.changed_files, path);
    assert.equal(written.native_changed_files, '');
    assert.equal(written.native_changed_files_explicit_empty, 'true');
  });

  it('filters only the known income harness from mixed native inputs', () => {
    const changedFiles = [
      'scripts/ios-test-income-e2e.sh',
      'ios/example-iosTests/ProfilePhotoViewModelTests.swift',
      'scripts/ios-test-unknown-e2e.sh',
    ].join('\n');
    const nativeFiles = nativeSelectorChangedFiles(changedFiles);
    assert.equal(nativeFiles, [
      'ios/example-iosTests/ProfilePhotoViewModelTests.swift',
      'scripts/ios-test-unknown-e2e.sh',
    ].join('\n'));
    const written = values(buildDetectOutputs(context(), {
      shouldRun: 'true', summary: '', changedFiles,
    }));
    assert.equal(written.native_changed_files, nativeFiles);
    assert.equal(written.native_changed_files_explicit_empty, 'false');
  });

  it('delimits a multi-line inventory so GitHub reads the whole value', () => {
    // An empty inventory still has to round-trip as a delimited value: the
    // native planner distinguishes "explicitly empty" from "absent".
    const text = formatStepOutputs(buildDetectOutputs(
      context({ reuseNativeEvidenceRaw: 'true' }),
      { shouldRun: 'true', summary: 'one\ntwo', changedFiles: 'ios/a.swift' },
    ));
    assert.match(
      text,
      /native_changed_files<<CHANGED_FILES_34933607516_2\n\nCHANGED_FILES_34933607516_2\n/,
    );
    assert.match(text, /changed_files<<CHANGED_FILES_34933607516_2\nios\/a\.swift\n/);
    assert.match(text, /summary<<SUMMARY\none\ntwo\nSUMMARY\n/);
  });
});

describe('detectEarlyExitOutputs', () => {
  it('covers every lane a manual run can want', () => {
    const written = values(detectEarlyExitOutputs(context(), {
      eventName: 'workflow_dispatch',
      baseUpdateSuperseded: 'false',
      baseUpdateDeferred: 'false',
    }) ?? []);
    assert.equal(written.should_run, 'true');
    assert.equal(written.storekit_required, 'true');
    assert.equal(written.onboarding_required, 'true');
    assert.equal(written.budget_required, 'true');
    assert.equal(written.evidence_required, 'false');
    assert.equal(written.summary, 'Manual run requested iOS checks.');
  });

  it('owns no checks for a superseded head, and says which head superseded it', () => {
    const written = values(detectEarlyExitOutputs(context(), {
      eventName: 'pull_request',
      baseUpdateSuperseded: 'true',
      baseUpdateDeferred: 'false',
    }) ?? []);
    assert.equal(written.should_run, 'false');
    assert.equal(written.summary, 'Superseded by a newer pull-request head.');
  });

  it('prefers the superseded answer when a head is both superseded and deferred', () => {
    const written = values(detectEarlyExitOutputs(context(), {
      eventName: 'pull_request',
      baseUpdateSuperseded: 'true',
      baseUpdateDeferred: 'true',
    }) ?? []);
    assert.equal(written.summary, 'Superseded by a newer pull-request head.');
  });

  it('reads only the exact string true, so an empty flag is not a skip', () => {
    assert.equal(detectEarlyExitOutputs(context(), {
      eventName: 'pull_request',
      baseUpdateSuperseded: '',
      baseUpdateDeferred: 'TRUE',
    }), undefined);
  });
});

describe('forcedLaneFlags', () => {
  it('forces the main lane for any of the four native shards', () => {
    for (const lane of ['native1', 'native2', 'native3', 'native4']) {
      assert.equal(forcedLaneFlags(`["${lane}"]`).mainRequired, true, lane);
    }
    assert.equal(forcedLaneFlags('["native5"]').mainRequired, false);
    assert.equal(forcedLaneFlags('["native1x"]').mainRequired, false);
  });

  it('forces the evidence lane for either evidence owner', () => {
    assert.equal(forcedLaneFlags('["evidence-account-update"]').evidenceRequired, true);
    assert.equal(forcedLaneFlags('["evidence-visual"]').evidenceRequired, true);
    assert.equal(forcedLaneFlags('["onboarding"]').evidenceRequired, false);
  });

  it('reads malformed or non-array plans as forcing nothing, exactly as jq -e failed', () => {
    for (const raw of ['', 'not json', '{"native1":true}', 'null', '[1,2]']) {
      assert.deepEqual(forcedLaneFlags(raw), { mainRequired: false, evidenceRequired: false }, raw);
    }
  });
});

describe('planIosChangeDetection', () => {
  const ios = 'ios/example-ios/Utils/AppRouter.swift';

  it('rejects unknown, duplicate, or malformed auxiliary plans', () => {
    for (const raw of ['["other"]', '["onboarding","onboarding"]', '"onboarding"', 'oops', '']) {
      assert.throws(
        () => planIosChangeDetection(context(), {
          eventName: 'pull_request', baseRef: 'develop', changedFiles: ios, reuseNativeEvidence: 'false', forcedIosAuxiliaryRaw: raw,
        }),
        (error: unknown) => error instanceof StepFailure
          && error.message === auxiliaryRerunErrors.invalidPlan,
        raw,
      );
    }
  });

  it('refuses retained native evidence with no proven auxiliary owner', () => {
    assert.throws(
      () => planIosChangeDetection(context(), {
        eventName: 'pull_request', baseRef: 'develop', changedFiles: ios, reuseNativeEvidence: 'true', forcedIosAuxiliaryRaw: '[]',
      }),
      (error: unknown) => error instanceof StepFailure
        && error.message === auxiliaryRerunErrors.noProvenOwner,
    );
  });

  it('refuses an auxiliary rerun that has no retained native evidence behind it', () => {
    assert.throws(
      () => planIosChangeDetection(context(), {
        eventName: 'pull_request', baseRef: 'develop', changedFiles: ios, reuseNativeEvidence: 'false', forcedIosAuxiliaryRaw: '["onboarding"]',
      }),
      (error: unknown) => error instanceof StepFailure
        && error.message === auxiliaryRerunErrors.withoutRetainedEvidence,
    );
  });

  it('raises only the proven auxiliary lane for retained native evidence', () => {
    const outcome = planIosChangeDetection(
      context({ reuseNativeEvidenceRaw: 'true' }),
      {
        eventName: 'pull_request', baseRef: 'develop', changedFiles: 'ios/example-ios/Core/Design/ExampleColors.swift',
        reuseNativeEvidence: 'true',
        forcedIosAuxiliaryRaw: '["onboarding"]',
      },
    );
    assert.equal(outcome.kind, 'final');
    const written = values(outcome.kind === 'final' ? outcome.outputs : []);
    assert.equal(written.onboarding_required, 'true');
    assert.equal(written.chat_plaid_required, 'false');
    assert.equal(written.income_required, 'false');
    assert.equal(written.budget_required, 'false');
  });

  it('does not widen the exact chat-plaid plan through the ordinary budget wildcard', () => {
    const outcome = planIosChangeDetection(
      context({ reuseNativeEvidenceRaw: 'true' }),
      {
        eventName: 'pull_request', baseRef: 'develop', changedFiles: 'server/services/chat/tools/registry.ts',
        reuseNativeEvidence: 'true',
        forcedIosAuxiliaryRaw: '["chat-plaid"]',
      },
    );
    assert.equal(outcome.kind, 'final');
    const written = values(outcome.kind === 'final' ? outcome.outputs : []);
    assert.equal(written.chat_plaid_required, 'true');
    assert.equal(written.onboarding_required, 'false');
    assert.equal(written.income_required, 'false');
    assert.equal(written.budget_required, 'false');
  });

  it('reruns a retained head with only the lanes its evidence recorded as failed', () => {
    const gate = context({ reuseNativeEvidenceRaw: 'true', forcedIosLanesRaw: '["native3"]' });
    const outcome = planIosChangeDetection(gate, {
      eventName: 'pull_request', baseRef: 'develop', changedFiles: '.github/workflows/ios-tests.yml',
      reuseNativeEvidence: 'true',
      forcedIosAuxiliaryRaw: '["onboarding"]',
    });
    assert.equal(outcome.kind, 'final');
    const written = values(outcome.kind === 'final' ? outcome.outputs : []);
    assert.equal(written.should_run, 'true');
    assert.equal(written.main_required, 'true');
    assert.equal(written.onboarding_required, 'true');
    assert.equal(written.storekit_required, 'false');
    assert.equal(written.evidence_required, 'false');
    assert.equal(
      written.summary,
      'Reusing retained native evidence while rerunning its proven auxiliary checks.',
    );
  });

  it('names the reused lanes when nothing but a lane rerun is left', () => {
    const gate = context({ forcedIosLanesRaw: '["native2","evidence-visual"]' });
    const outcome = planIosChangeDetection(gate, {
      eventName: 'pull_request', baseRef: 'develop', changedFiles: 'README.md',
      reuseNativeEvidence: 'false',
      forcedIosAuxiliaryRaw: '[]',
    });
    assert.equal(outcome.kind, 'final');
    const written = values(outcome.kind === 'final' ? outcome.outputs : []);
    assert.equal(written.should_run, 'true');
    assert.equal(written.main_required, 'true');
    assert.equal(written.evidence_required, 'true');
    assert.equal(written.onboarding_required, 'false');
    assert.equal(
      written.summary,
      'Reusing prior successful iOS lanes and rerunning only: native2, evidence-visual.',
    );
  });

  it('runs a lane-only check when its owner has no native iOS inventory path', () => {
    // The Plaid route owns onboarding without reaching the native selector.
    const outcome = planIosChangeDetection(context({ forcedIosLanesRaw: '["native1"]' }), {
      eventName: 'pull_request', baseRef: 'develop', changedFiles: 'server/routes/plaid.yaml',
      reuseNativeEvidence: 'false',
      forcedIosAuxiliaryRaw: '[]',
    });
    assert.equal(outcome.kind, 'final');
    const written = values(outcome.kind === 'final' ? outcome.outputs : []);
    assert.equal(written.onboarding_required, 'true');
  });

  it('skips iOS entirely when no path and no retained lane asks for it', () => {
    const outcome = planIosChangeDetection(context(), {
      eventName: 'pull_request', baseRef: 'develop', changedFiles: 'docs/ci.md\nREADME.md',
      reuseNativeEvidence: 'false',
      forcedIosAuxiliaryRaw: '[]',
    });
    assert.equal(outcome.kind, 'final');
    const written = values(outcome.kind === 'final' ? outcome.outputs : []);
    assert.equal(written.should_run, 'false');
    assert.equal(written.changed_files, 'docs/ci.md\nREADME.md');
    assert.equal(
      written.summary,
      'No iOS app, iOS test, or iOS test infrastructure files changed.',
    );
  });
});

describe('planIosChangeDetection real-server selection', () => {
  const serverInternal = 'server/services/chat/services/inputNormalization.ts\n'
    + 'server/services/chat/tools/registry.ts\n'
    + 'server/tests/inputNormalizationService.test.ts';

  it('runs path-selected real-server lanes on a pull request into develop', () => {
    const plan = selectionPlan(planIosChangeDetection(context(), {
      eventName: 'pull_request', baseRef: 'develop', changedFiles: serverInternal,
      reuseNativeEvidence: 'false', forcedIosAuxiliaryRaw: '[]',
    }));
    assert.equal(plan.classification.chatPlaidRequired, true);
    assert.equal(plan.classification.budgetRequired, true);
    const written = values(completeIosChangeDetection(context(), plan, {
      evidenceRequired: false, mainRequired: false, onboardingRequired: false,
    }, 'false'));
    assert.equal(written.chat_plaid_required, 'true');
    assert.equal(written.budget_required, 'true');
    assert.doesNotMatch(written.summary ?? '', /deferred/);
  });

  it('runs selector-chosen onboarding on a pull request into develop', () => {
    const plan = selectionPlan(planIosChangeDetection(context(), {
      eventName: 'pull_request', baseRef: 'develop',
      changedFiles: 'ios/example-iosUITests/BudgetBaseUITestCase.swift',
      reuseNativeEvidence: 'false', forcedIosAuxiliaryRaw: '[]',
    }));
    const written = values(completeIosChangeDetection(context(), plan, {
      evidenceRequired: false, mainRequired: true, onboardingRequired: true,
    }, 'false'));
    assert.equal(written.onboarding_required, 'true');
    assert.match(written.summary ?? '', /Onboarding E2E required by targeted path changes/);
  });

  it('runs a selected lane even when no native iOS files changed', () => {
    const outcome = planIosChangeDetection(context(), {
      eventName: 'pull_request', baseRef: 'develop',
      changedFiles: 'server/routes/plaid.yaml',
      reuseNativeEvidence: 'false', forcedIosAuxiliaryRaw: '[]',
    });
    assert.equal(outcome.kind, 'final');
    const written = values(outcome.kind === 'final' ? outcome.outputs : []);
    assert.equal(written.should_run, 'true');
    assert.equal(written.onboarding_required, 'true');
  });

  it('keeps retained-evidence reruns limited to the controller-proven auxiliary lanes', () => {
    const outcome = planIosChangeDetection(context({ reuseNativeEvidenceRaw: 'true' }), {
      eventName: 'pull_request', baseRef: 'develop', changedFiles: 'server/services/chat/tools/registry.ts',
      reuseNativeEvidence: 'true', forcedIosAuxiliaryRaw: '["chat-plaid"]',
    });
    assert.equal(outcome.kind, 'final');
    const written = values(outcome.kind === 'final' ? outcome.outputs : []);
    assert.equal(written.chat_plaid_required, 'true');
    assert.equal(written.budget_required, 'false');
  });
});

describe('readSelectorDecision', () => {
  it('accepts only the two decisions a selector may write', () => {
    assert.equal(readSelectorDecision('true', selectorDecisionErrors.mainShouldRun), true);
    assert.equal(readSelectorDecision('false', selectorDecisionErrors.mainShouldRun), false);
  });

  it('fails the step rather than reading a missing decision as a skip', () => {
    for (const value of ['', 'TRUE', '1', 'yes']) {
      assert.throws(
        () => readSelectorDecision(value, selectorDecisionErrors.evidenceShouldRun),
        (error: unknown) => error instanceof StepFailure
          && error.message
            === '::error::Evidence selector did not emit a valid should_run decision.',
        value,
      );
    }
  });
});

describe('completeIosChangeDetection', () => {
  const plan = selectionPlan(planIosChangeDetection(context(), {
    eventName: 'merge_group', baseRef: 'develop', changedFiles: 'ios/example-ios/UI/PaywallView.swift\n'
      + 'ios/example-ios/UI/Cards/Budget/BudgetView.swift',
    reuseNativeEvidence: 'false',
    forcedIosAuxiliaryRaw: '[]',
  }));

  it('lists the inventory and every selected lane in the summary', () => {
    const written = values(completeIosChangeDetection(context(), plan, {
      evidenceRequired: true, mainRequired: true, onboardingRequired: false,
    }, 'false'));
    assert.equal(written.should_run, 'true');
    assert.deepEqual((written.summary ?? '').split('\n'), [
      'iOS checks required because these files changed:',
      'ios/example-ios/UI/PaywallView.swift',
      'ios/example-ios/UI/Cards/Budget/BudgetView.swift',
      'StoreKit purchase check required by targeted path changes.',
      'Main XCTest lane required by targeted path changes.',
      'Onboarding E2E required by targeted path changes.',
      'Budget real-server E2E required by targeted path changes.',
      'Account-update acceptance lane required by targeted path changes.',
    ]);
  });

  it('never lowers an onboarding requirement the path owners already raised', () => {
    const written = values(completeIosChangeDetection(context(), plan, {
      evidenceRequired: false, mainRequired: false, onboardingRequired: false,
    }, 'false'));
    assert.equal(written.onboarding_required, 'true');
  });

  it('raises onboarding when only the selector knows the target compiles it', () => {
    const helper = selectionPlan(planIosChangeDetection(context(), {
      eventName: 'merge_group', baseRef: 'develop', changedFiles: 'ios/example-iosUITests/BudgetBaseUITestCase.swift',
      reuseNativeEvidence: 'false',
      forcedIosAuxiliaryRaw: '[]',
    }));
    assert.equal(helper.onboardingRequired, false);
    assert.equal(
      values(completeIosChangeDetection(context(), helper, {
        evidenceRequired: false, mainRequired: true, onboardingRequired: true,
      }, 'false')).onboarding_required,
      'true',
    );
  });

  it('suppresses the lanes retained evidence proved, then re-enables a failed one', () => {
    const gate = context({ reuseNativeEvidenceRaw: 'true', forcedIosLanesRaw: '["native4"]' });
    const written = values(completeIosChangeDetection(gate, plan, {
      evidenceRequired: true, mainRequired: true, onboardingRequired: true,
    }, 'true'));
    assert.equal(written.storekit_required, 'false');
    assert.equal(written.evidence_required, 'false');
    assert.equal(written.main_required, 'true');
    assert.equal(written.budget_required, 'true', 'E2E lanes keep routing off the effective patch');
    assert.equal(written.native_changed_files, '');
  });

  it('leaves every lane suppressed when retained evidence records no failure', () => {
    const gate = context({ reuseNativeEvidenceRaw: 'true' });
    const written = values(completeIosChangeDetection(gate, plan, {
      evidenceRequired: true, mainRequired: true, onboardingRequired: true,
    }, 'true'));
    assert.equal(written.main_required, 'false');
    assert.equal(written.evidence_required, 'false');
  });

  it('honours a forced evidence lane on a run that has no retained evidence', () => {
    const gate = context({ forcedIosLanesRaw: '["evidence-account-update"]' });
    const written = values(completeIosChangeDetection(gate, plan, {
      evidenceRequired: false, mainRequired: false, onboardingRequired: false,
    }, 'false'));
    assert.equal(written.evidence_required, 'true');
    assert.equal(written.main_required, 'false');
  });
});
