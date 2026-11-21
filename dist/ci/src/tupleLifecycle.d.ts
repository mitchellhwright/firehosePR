import { z } from 'zod';
export declare const activeRunStatuses: readonly ['queued', 'in_progress', 'pending', 'requested', 'waiting'];
export declare const workflowRunStatusSchema: z.ZodEnum<{
    completed: "completed";
    in_progress: "in_progress";
    pending: "pending";
    queued: "queued";
    requested: "requested";
    waiting: "waiting";
}>;
export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;
export declare const pullRequestTupleSchema: z.ZodObject<{
    number: z.ZodNumber;
    state: z.ZodEnum<{
        closed: "closed";
        open: "open";
    }>;
    draft: z.ZodBoolean;
    head: z.ZodObject<{
        sha: z.ZodString;
        ref: z.ZodString;
        repository: z.ZodString;
    }, z.core.$strict>;
    base: z.ZodObject<{
        sha: z.ZodString;
        ref: z.ZodString;
        repository: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>;
export type PullRequestTuple = z.infer<typeof pullRequestTupleSchema>;
export declare const workflowRunSchema: z.ZodObject<{
    id: z.ZodNumber;
    workflow: z.ZodString;
    headSha: z.ZodString;
    status: z.ZodEnum<{
        completed: "completed";
        in_progress: "in_progress";
        pending: "pending";
        queued: "queued";
        requested: "requested";
        waiting: "waiting";
    }>;
    createdAt: z.ZodNullable<z.ZodISODateTime>;
    pullRequests: z.ZodArray<z.ZodObject<{
        number: z.ZodNumber;
        baseRef: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type WorkflowRun = z.infer<typeof workflowRunSchema>;
declare const verifiedAncestorSchema: z.ZodObject<{
    headSha: z.ZodString;
    completedReusableEvidence: z.ZodBoolean;
}, z.core.$strict>;
export type VerifiedAncestor = z.infer<typeof verifiedAncestorSchema>;
export declare const tupleLifecycleInputSchema: z.ZodObject<{
    repository: z.ZodString;
    event: z.ZodObject<{
        action: z.ZodString;
        previousHeadSha: z.ZodNullable<z.ZodString>;
        baseChanged: z.ZodBoolean;
        fullRouting: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strict>;
    pullRequest: z.ZodObject<{
        number: z.ZodNumber;
        state: z.ZodEnum<{
            closed: "closed";
            open: "open";
        }>;
        draft: z.ZodBoolean;
        head: z.ZodObject<{
            sha: z.ZodString;
            ref: z.ZodString;
            repository: z.ZodString;
        }, z.core.$strict>;
        base: z.ZodObject<{
            sha: z.ZodString;
            ref: z.ZodString;
            repository: z.ZodString;
        }, z.core.$strict>;
    }, z.core.$strict>;
    livePullRequest: z.ZodNullable<z.ZodObject<{
        number: z.ZodNumber;
        state: z.ZodEnum<{
            closed: "closed";
            open: "open";
        }>;
        draft: z.ZodBoolean;
        head: z.ZodObject<{
            sha: z.ZodString;
            ref: z.ZodString;
            repository: z.ZodString;
        }, z.core.$strict>;
        base: z.ZodObject<{
            sha: z.ZodString;
            ref: z.ZodString;
            repository: z.ZodString;
        }, z.core.$strict>;
    }, z.core.$strict>>;
    iosExecutionScopeChangedByHead: z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodBoolean>>;
    patchEquivalentPredecessor: z.ZodNullable<z.ZodBoolean>;
    verifiedLineage: z.ZodArray<z.ZodObject<{
        headSha: z.ZodString;
        completedReusableEvidence: z.ZodBoolean;
    }, z.core.$strict>>;
    runs: z.ZodArray<z.ZodObject<{
        id: z.ZodNumber;
        workflow: z.ZodString;
        headSha: z.ZodString;
        status: z.ZodEnum<{
            completed: "completed";
            in_progress: "in_progress";
            pending: "pending";
            queued: "queued";
            requested: "requested";
            waiting: "waiting";
        }>;
        createdAt: z.ZodNullable<z.ZodISODateTime>;
        pullRequests: z.ZodArray<z.ZodObject<{
            number: z.ZodNumber;
            baseRef: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    queuedOnlyRunIds: z.ZodDefault<z.ZodArray<z.ZodNumber>>;
}, z.core.$strict>;
export type TupleLifecycleInput = z.input<typeof tupleLifecycleInputSchema>;
export declare const tupleDispositionSchema: z.ZodEnum<{
    "cancel-obsolete": "cancel-obsolete";
    "cancel-prior-base": "cancel-prior-base";
    current: "current";
    "retain-patch-equivalent-predecessor": "retain-patch-equivalent-predecessor";
}>;
export type TupleDisposition = z.infer<typeof tupleDispositionSchema>;
export declare const planReasonCodeSchema: z.ZodEnum<{
    "decisions-derived": "decisions-derived";
    "event-not-handled": "event-not-handled";
    "facts-incomplete": "facts-incomplete";
    "ios-scope-unchanged": "ios-scope-unchanged";
    "previous-head-unknown": "previous-head-unknown";
    "pull-request-not-ready": "pull-request-not-ready";
    "tuple-outside-repository": "tuple-outside-repository";
    "tuple-superseded": "tuple-superseded";
}>;
export type PlanReasonCode = z.infer<typeof planReasonCodeSchema>;
export declare const tupleLifecyclePlanSchema: z.ZodObject<{
    schema: z.ZodLiteral<"firehosepr.tuple-lifecycle-plan.v2">;
    workflow: z.ZodLiteral<"Test - iOS">;
    trigger: z.ZodNullable<z.ZodEnum<{
        "full-routing": "full-routing";
        retarget: "retarget";
        synchronize: "synchronize";
    }>>;
    tuple: z.ZodObject<{
        pullRequest: z.ZodNumber;
        headSha: z.ZodString;
        baseSha: z.ZodString;
        baseRef: z.ZodString;
    }, z.core.$strict>;
    applicable: z.ZodBoolean;
    reasonCode: z.ZodEnum<{
        "decisions-derived": "decisions-derived";
        "event-not-handled": "event-not-handled";
        "facts-incomplete": "facts-incomplete";
        "ios-scope-unchanged": "ios-scope-unchanged";
        "previous-head-unknown": "previous-head-unknown";
        "pull-request-not-ready": "pull-request-not-ready";
        "tuple-outside-repository": "tuple-outside-repository";
        "tuple-superseded": "tuple-superseded";
    }>;
    decisions: z.ZodArray<z.ZodObject<{
        runId: z.ZodNumber;
        headSha: z.ZodString;
        disposition: z.ZodEnum<{
            "cancel-obsolete": "cancel-obsolete";
            "cancel-prior-base": "cancel-prior-base";
            current: "current";
            "retain-patch-equivalent-predecessor": "retain-patch-equivalent-predecessor";
        }>;
        reasonCode: z.ZodEnum<{
            "current-head": "current-head";
            "obsolete-head": "obsolete-head";
            "predecessor-not-executing": "predecessor-not-executing";
            "prior-base-branch": "prior-base-branch";
            "retained-verified-ancestor": "retained-verified-ancestor";
        }>;
    }, z.core.$strict>>;
    ignoredRuns: z.ZodArray<z.ZodObject<{
        runId: z.ZodNumber;
        reasonCode: z.ZodEnum<{
            "ios-scope-unchanged": "ios-scope-unchanged";
            "not-current-head": "not-current-head";
            "pull-request-mismatch": "pull-request-mismatch";
            "run-not-active": "run-not-active";
            "workflow-out-of-scope": "workflow-out-of-scope";
        }>;
    }, z.core.$strict>>;
    cancelRunIds: z.ZodArray<z.ZodNumber>;
    retainRunIds: z.ZodArray<z.ZodNumber>;
}, z.core.$strict>;
export type TupleLifecyclePlan = z.infer<typeof tupleLifecyclePlanSchema>;
type ParsedInput = z.infer<typeof tupleLifecycleInputSchema>;
type Trigger = NonNullable<TupleLifecyclePlan['trigger']>;
/** Which cancellation rule an event invokes, or `null` when it invokes none. */
export declare function triggerOf(event: ParsedInput['event']): Trigger | null;
export declare function deriveTupleLifecyclePlan(rawInput: TupleLifecycleInput): TupleLifecyclePlan;
export {};
