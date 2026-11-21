// GENERATED from ci/workflows — edit the definitions, not this file.
// Regenerate with: npm run ci:workflows

export interface PublishedName {
  readonly name: string;
  readonly literals: readonly string[];
  readonly pattern: string;
  readonly suffixed: boolean;
}

/** Every workflow and job name the typed definitions render. */
export const workflowNames = Object.freeze({
  "actions-artifact-cleanup": Object.freeze({
    workflow: "Actions Artifact Cleanup",
    jobs: Object.freeze({
      "prune-superseded-caches": Object.freeze({
        name: "Prune superseded XCTest caches",
        literals: Object.freeze(["Prune superseded XCTest caches"]),
        pattern: "^Prune superseded XCTest caches$",
        suffixed: false,
      }),
    }),
  }),
  "branch-policy-monitor": Object.freeze({
    workflow: "Branch Policy Drift Monitor",
    jobs: Object.freeze({
      "confirm-activation": Object.freeze({
        name: "Confirm branch policy monitor activation",
        literals: Object.freeze(["Confirm branch policy monitor activation"]),
        pattern: "^Confirm branch policy monitor activation$",
        suffixed: false,
      }),
      "inspect": Object.freeze({
        name: "Inspect branch protection and admin access",
        literals: Object.freeze(["Inspect branch protection and admin access"]),
        pattern: "^Inspect branch protection and admin access$",
        suffixed: false,
      }),
    }),
  }),
  "cancel-blocked-pr-ci": Object.freeze({
    workflow: "PR terminal cleanup",
    jobs: Object.freeze({
      "cancel-blocked-pr-ci": Object.freeze({
        name: "Cancel abandoned PR work",
        literals: Object.freeze(["Cancel abandoned PR work"]),
        pattern: "^Cancel abandoned PR work$",
        suffixed: false,
      }),
    }),
  }),
  "cancel-dequeued-candidate": Object.freeze({
    workflow: "Merge queue candidate cleanup",
    jobs: Object.freeze({
      "cancel-dequeued-candidate": Object.freeze({
        name: "Cancel dequeued candidate work",
        literals: Object.freeze(["Cancel dequeued candidate work"]),
        pattern: "^Cancel dequeued candidate work$",
        suffixed: false,
      }),
    }),
  }),
  "enable-internal-pr-auto-merge": Object.freeze({
    workflow: "Enable native PR auto-merge",
    jobs: Object.freeze({
      "enable-auto-merge": Object.freeze({
        name: "Arm native auto-merge",
        literals: Object.freeze(["Arm native auto-merge"]),
        pattern: "^Arm native auto-merge$",
        suffixed: false,
      }),
    }),
  }),
  "hosted-linux-admission": Object.freeze({
    workflow: "Hosted Linux admission",
    jobs: Object.freeze({
      "probe": Object.freeze({
        name: "Hosted Linux admission probe",
        literals: Object.freeze(["Hosted Linux admission probe"]),
        pattern: "^Hosted Linux admission probe$",
        suffixed: false,
      }),
    }),
  }),
  "install-runner-cleanup-hooks": Object.freeze({
    workflow: "Install runner cleanup hooks",
    jobs: Object.freeze({
      "reconcile-host": Object.freeze({
        name: "Dispatch runner maintenance",
        literals: Object.freeze(["Dispatch runner maintenance"]),
        pattern: "^Dispatch runner maintenance \\((?<suffix>.*)\\)$",
        suffixed: true,
      }),
    }),
  }),
  "install-runner-cleanup-host": Object.freeze({
    workflow: "Install runner cleanup hook host",
    jobs: Object.freeze({
      "install": Object.freeze({
        name: "Install runner cleanup hook",
        literals: Object.freeze(["Install runner cleanup hook"]),
        pattern: "^Install runner cleanup hook \\((?<suffix>.*)\\)$",
        suffixed: true,
      }),
    }),
  }),
  "linux-runner-heartbeat": Object.freeze({
    workflow: "Linux runner heartbeat",
    jobs: Object.freeze({
      "portable-heartbeat": Object.freeze({
        name: "External Linux heartbeat (portable)",
        literals: Object.freeze(["External Linux heartbeat (portable)"]),
        pattern: "^External Linux heartbeat \\(portable\\)$",
        suffixed: false,
      }),
      "database-heartbeat": Object.freeze({
        name: "External Linux heartbeat (database)",
        literals: Object.freeze(["External Linux heartbeat (database)"]),
        pattern: "^External Linux heartbeat \\(database\\)$",
        suffixed: false,
      }),
    }),
  }),
  "native-terminal-ios-cancel": Object.freeze({
    workflow: "Cancel terminal iOS validation",
    jobs: Object.freeze({
      "terminal-signal": Object.freeze({
        name: "Cancel terminal PR validation natively",
        literals: Object.freeze(["Cancel terminal PR validation natively"]),
        pattern: "^Cancel terminal PR validation natively$",
        suffixed: false,
      }),
    }),
  }),
  "native-terminal-pr-checks-cancel": Object.freeze({
    workflow: "Cancel terminal PR Checks",
    jobs: Object.freeze({
      "terminal-signal": Object.freeze({
        name: "Cancel terminal PR validation natively",
        literals: Object.freeze(["Cancel terminal PR validation natively"]),
        pattern: "^Cancel terminal PR validation natively$",
        suffixed: false,
      }),
    }),
  }),
  "node-modules-cache": Object.freeze({
    workflow: "Node.js dependency cache",
    jobs: Object.freeze({
      "populate": Object.freeze({
        name: "Save the Node.js dependency cache",
        literals: Object.freeze(["Save the Node.js dependency cache"]),
        pattern: "^Save the Node\\.js dependency cache$",
        suffixed: false,
      }),
    }),
  }),
  "production-deploy-dispatch": Object.freeze({
    workflow: "Production deploy dispatch",
    jobs: Object.freeze({
      "dispatch-production-e2e": Object.freeze({
        name: "Dispatch production onboarding E2E",
        literals: Object.freeze(["Dispatch production onboarding E2E"]),
        pattern: "^Dispatch production onboarding E2E$",
        suffixed: false,
      }),
    }),
  }),
  "promotion-checkpoint": Object.freeze({
    workflow: "Create promotion checkpoint",
    jobs: Object.freeze({
      "checkpoint": Object.freeze({
        name: "Freeze develop promotion checkpoint",
        literals: Object.freeze(["Freeze develop promotion checkpoint"]),
        pattern: "^Freeze develop promotion checkpoint$",
        suffixed: false,
      }),
    }),
  }),
  "refresh-pr-ci-after-base-edit": Object.freeze({
    workflow: "Refresh PR CI after base change",
    jobs: Object.freeze({
      "route-initial-control": Object.freeze({
        name: "Route continuity controllers to available Linux capacity",
        literals: Object.freeze(["Route continuity controllers to available Linux capacity"]),
        pattern: "^Route continuity controllers to available Linux capacity$",
        suffixed: false,
      }),
      "fan-out-base-update": Object.freeze({
        name: "Update overlapping pull requests",
        literals: Object.freeze(["Update overlapping pull requests"]),
        pattern: "^Update overlapping pull requests$",
        suffixed: false,
      }),
      "cancel-obsolete-ios": Object.freeze({
        name: "Keep PR work current",
        literals: Object.freeze(["Keep PR work current"]),
        pattern: "^Keep PR work current$",
        suffixed: false,
      }),
      "resume-retained-ios": Object.freeze({
        name: "Resume retained iOS run",
        literals: Object.freeze(["Resume retained iOS run"]),
        pattern: "^Resume retained iOS run$",
        suffixed: false,
      }),
      "recheck-promotion-after-evidence": Object.freeze({
        name: "Recheck promotion after evidence",
        literals: Object.freeze(["Recheck promotion after evidence"]),
        pattern: "^Recheck promotion after evidence$",
        suffixed: false,
      }),
      "cancel-conflicted-pr-ci": Object.freeze({
        name: "Cancel conflicted PR work",
        literals: Object.freeze(["Cancel conflicted PR work"]),
        pattern: "^Cancel conflicted PR work$",
        suffixed: false,
      }),
    }),
  }),
  "ios-tests": Object.freeze({
    workflow: "Test - iOS",
    jobs: Object.freeze({
      "sync-observability-github-token": Object.freeze({
        name: "Sync observability GitHub credential",
        literals: Object.freeze(["Sync observability GitHub credential"]),
        pattern: "^Sync observability GitHub credential$",
        suffixed: false,
      }),
      "route-initial-control": Object.freeze({
        name: "Route iOS planner to available Linux capacity",
        literals: Object.freeze(["Route iOS planner to available Linux capacity"]),
        pattern: "^Route iOS planner to available Linux capacity$",
        suffixed: false,
      }),
      "ios-change-gate": Object.freeze({
        name: "iOS Change Gate",
        literals: Object.freeze(["iOS Change Gate", "Manual - iOS Change Gate"]),
        pattern: "^(?:iOS Change Gate|Manual - iOS Change Gate)$",
        suffixed: false,
      }),
      "release-full-routing-predecessor": Object.freeze({
        name: "Release retained iOS predecessor",
        literals: Object.freeze(["Release retained iOS predecessor"]),
        pattern: "^Release retained iOS predecessor$",
        suffixed: false,
      }),
      "await-retained-ios-predecessor": Object.freeze({
        name: "Await retained iOS predecessor",
        literals: Object.freeze(["Await retained iOS predecessor"]),
        pattern: "^Await retained iOS predecessor$",
        suffixed: false,
      }),
      "cancel-deleted-queue-candidate": Object.freeze({
        name: "Cancel deleted queue candidate",
        literals: Object.freeze(["Cancel deleted queue candidate"]),
        pattern: "^Cancel deleted queue candidate$",
        suffixed: false,
      }),
      "confirm-current-ios-pr": Object.freeze({
        name: "Confirm current iOS PR tuple before Mac allocation",
        literals: Object.freeze(["Confirm current iOS PR tuple before Mac allocation"]),
        pattern: "^Confirm current iOS PR tuple before Mac allocation$",
        suffixed: false,
      }),
      "verify-ios-release-archive": Object.freeze({
        name: "Verify unsigned Release archive",
        literals: Object.freeze(["Verify unsigned Release archive"]),
        pattern: "^Verify unsigned Release archive$",
        suffixed: false,
      }),
      "build-ios-native-test-products": Object.freeze({
        name: "Build shared native iOS test products",
        literals: Object.freeze(["Build shared native iOS test products"]),
        pattern: "^Build shared native iOS test products$",
        suffixed: false,
      }),
      "test-ios-execution": Object.freeze({
        name: "Test - iOS execution",
        literals: Object.freeze(["Test - iOS execution"]),
        pattern: "^Test - iOS execution \\((?<suffix>.*)\\)$",
        suffixed: true,
      }),
      "test-ios": Object.freeze({
        name: "Test - iOS",
        literals: Object.freeze(["Test - iOS", "Manual - Test - iOS"]),
        pattern: "^(?:Test - iOS|Manual - Test - iOS)$",
        suffixed: false,
      }),
      "storekit-purchase-status": Object.freeze({
        name: "StoreKit Purchase - iOS",
        literals: Object.freeze(["StoreKit Purchase - iOS"]),
        pattern: "^StoreKit Purchase - iOS$",
        suffixed: false,
      }),
      "build-ios-e2e-test-products": Object.freeze({
        name: "Build shared iOS E2E test products",
        literals: Object.freeze(["Build shared iOS E2E test products"]),
        pattern: "^Build shared iOS E2E test products$",
        suffixed: false,
      }),
      "prepare-dev-e2e-schema": Object.freeze({
        name: "Verify development E2E schema",
        literals: Object.freeze(["Verify development E2E schema"]),
        pattern: "^Verify development E2E schema$",
        suffixed: false,
      }),
      "onboarding-e2e": Object.freeze({
        name: "Real-server E2E execution (onboarding)",
        literals: Object.freeze(["Real-server E2E execution (onboarding)"]),
        pattern: "^Real-server E2E execution \\(onboarding\\)$",
        suffixed: false,
      }),
      "chat-plaid-e2e": Object.freeze({
        name: "Real-server E2E execution (chat-plaid)",
        literals: Object.freeze(["Real-server E2E execution (chat-plaid)"]),
        pattern: "^Real-server E2E execution \\(chat-plaid\\)$",
        suffixed: false,
      }),
      "income-e2e": Object.freeze({
        name: "Real-server E2E execution (income)",
        literals: Object.freeze(["Real-server E2E execution (income)"]),
        pattern: "^Real-server E2E execution \\(income\\)$",
        suffixed: false,
      }),
      "budget-e2e": Object.freeze({
        name: "Real-server E2E execution",
        literals: Object.freeze(["Real-server E2E execution"]),
        pattern: "^Real-server E2E execution \\((?<suffix>.*)\\)$",
        suffixed: true,
      }),
      "budget-e2e-video-processing": Object.freeze({
        name: "Budget E2E video processing (non-gating)",
        literals: Object.freeze(["Budget E2E video processing (non-gating)"]),
        pattern: "^Budget E2E video processing \\(non-gating\\)$",
        suffixed: false,
      }),
      "onboarding-e2e-status": Object.freeze({
        name: "Onboarding E2E",
        literals: Object.freeze(["Onboarding E2E", "Manual - Onboarding E2E"]),
        pattern: "^(?:Onboarding E2E|Manual - Onboarding E2E)$",
        suffixed: false,
      }),
      "remove-run-artifacts-after-success": Object.freeze({
        name: "Remove run artifacts after success",
        literals: Object.freeze(["Remove run artifacts after success"]),
        pattern: "^Remove run artifacts after success$",
        suffixed: false,
      }),
    }),
  }),
  "pr-checks": Object.freeze({
    workflow: "PR Checks",
    jobs: Object.freeze({
      "route-initial-control": Object.freeze({
        name: "Route PR planner to available Linux capacity",
        literals: Object.freeze(["Route PR planner to available Linux capacity"]),
        pattern: "^Route PR planner to available Linux capacity$",
        suffixed: false,
      }),
      "plan-pr-validation": Object.freeze({
        name: "Plan PR validation",
        literals: Object.freeze(["Plan PR validation"]),
        pattern: "^(?:Plan PR validation|^Docs Change Gate$)$",
        suffixed: false,
      }),
      "lint": Object.freeze({
        name: "Lint changed code",
        literals: Object.freeze(["Lint changed code"]),
        pattern: "^Lint changed code$",
        suffixed: false,
      }),
      "validation-policy": Object.freeze({
        name: "Evaluate PR validation policy",
        literals: Object.freeze(["Evaluate PR validation policy"]),
        pattern: "^Evaluate PR validation policy$",
        suffixed: false,
      }),
      "workflow-contracts": Object.freeze({
        name: "Workflow contracts",
        literals: Object.freeze(["Workflow contracts"]),
        pattern: "^Workflow contracts$",
        suffixed: false,
      }),
      "server-static": Object.freeze({
        name: "Server static validation",
        literals: Object.freeze(["Server static validation"]),
        pattern: "^Server static validation$",
        suffixed: false,
      }),
      "server-process-tests": Object.freeze({
        name: "Server process-heavy tests",
        literals: Object.freeze(["Server process-heavy tests"]),
        pattern: "^Server process-heavy tests$",
        suffixed: false,
      }),
      "server-tests": Object.freeze({
        name: "Server tests",
        literals: Object.freeze(["Server tests"]),
        pattern: "^Server tests \\((?<suffix>.*)\\)$",
        suffixed: true,
      }),
      "targeted-server-tests": Object.freeze({
        name: "Targeted server tests",
        literals: Object.freeze(["Targeted server tests"]),
        pattern: "^Targeted server tests$",
        suffixed: false,
      }),
      "ios-contracts": Object.freeze({
        name: "iOS-server contracts",
        literals: Object.freeze(["iOS-server contracts"]),
        pattern: "^iOS-server contracts$",
        suffixed: false,
      }),
      "validate": Object.freeze({
        name: "Validate pull request changes",
        literals: Object.freeze(["Validate pull request changes"]),
        pattern: "^Validate pull request changes$",
        suffixed: false,
      }),
      "database-integration": Object.freeze({
        name: "Run database integration tests",
        literals: Object.freeze(["Run database integration tests"]),
        pattern: "^Run database integration tests$",
        suffixed: false,
      }),
    }),
  }),
  "runner-activation-complete": Object.freeze({
    workflow: "Complete runner activation",
    jobs: Object.freeze({
      "activation-complete": Object.freeze({
        name: "Confirm runner activation",
        literals: Object.freeze(["Confirm runner activation"]),
        pattern: "^Confirm runner activation$",
        suffixed: false,
      }),
    }),
  }),
  "trusted-production-onboarding-e2e": Object.freeze({
    workflow: "Trusted production onboarding E2E",
    jobs: Object.freeze({
      "validate-trusted-ref": Object.freeze({
        name: "Validate trusted production E2E ref",
        literals: Object.freeze(["Validate trusted production E2E ref"]),
        pattern: "^Validate trusted production E2E ref$",
        suffixed: false,
      }),
      "production-onboarding-e2e": Object.freeze({
        name: "Production onboarding E2E execution",
        literals: Object.freeze(["Production onboarding E2E execution"]),
        pattern: "^Production onboarding E2E execution$",
        suffixed: false,
      }),
      "production-video-review": Object.freeze({
        name: "Production onboarding video review (advisory)",
        literals: Object.freeze(["Production onboarding video review (advisory)"]),
        pattern: "^Production onboarding video review \\(advisory\\)$",
        suffixed: false,
      }),
    }),
  }),
  "vendored-linkkit-version-check": Object.freeze({
    workflow: "Vendored LinkKit version check",
    jobs: Object.freeze({
      "check": Object.freeze({
        name: "Compare vendored LinkKit with the latest release",
        literals: Object.freeze(["Compare vendored LinkKit with the latest release"]),
        pattern: "^Compare vendored LinkKit with the latest release$",
        suffixed: false,
      }),
    }),
  }),
  "video-review-writer": Object.freeze({
    workflow: "Advisory video issue writer",
    jobs: Object.freeze({
      "consume": Object.freeze({
        name: "Publish advisory video review findings",
        literals: Object.freeze(["Publish advisory video review findings"]),
        pattern: "^Publish advisory video review findings$",
        suffixed: false,
      }),
    }),
  }),
  "xcode-cloud-build-tags": Object.freeze({
    workflow: "Track Xcode Cloud builds",
    jobs: Object.freeze({
      "reconcile": Object.freeze({
        name: "Tag successful Xcode Cloud main builds",
        literals: Object.freeze(["Tag successful Xcode Cloud main builds"]),
        pattern: "^Tag successful Xcode Cloud main builds$",
        suffixed: false,
      }),
    }),
  }),
} as const);

/**
 * The compiled matcher for a published name. Consumers match with this
 * rather than rebuilding a pattern from the literal, because a name's shape
 * — a parenthesised suffix, an alternation, a spelling still in flight on an
 * open pull request — is part of what the definition decides.
 *
 */
export function nameRegExp(matcher: Pick<PublishedName, 'pattern'>): RegExp {
  return new RegExp(matcher.pattern);
}
