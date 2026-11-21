#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { VIDEO_FINDING_IDENTITIES } from '../videoReview/identities.ts';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { workflowNames } from '../../../scripts/ci/generated/workflow-names.ts';

// The review comment is titled after the gate whose video it reviews, so the
// heading follows that job's published name instead of restating it.
const REVIEW_HEADING = `## ${workflowNames['ios-tests'].jobs['onboarding-e2e-status'].name} Video Review`;
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const MAX_LOG_CHARS = 14000;
const MAX_EVIDENCE_TIMELINE_CHARS = 24000;
const DEFAULT_MAX_FRAMES = 180;
const DEFAULT_FRAME_WIDTH = 512;

interface ReviewContext {
  readonly videoPath: string;
  readonly videoSize: string;
  readonly durationSeconds: number;
  readonly frameCount: number;
  readonly selectedFrameCount: number;
  readonly intervalSeconds: number;
  readonly xcodebuildEvidenceTimeline: string;
  readonly xcodebuildLogTail: string;
  readonly resultBundlePath: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly runUrl: string;
  readonly repository: string;
  readonly commitSha: string;
  readonly ref: string;
  readonly eventName: string;
  readonly isProductionE2E: boolean;
}

interface ReviewFinding {
  readonly id: string;
  readonly kind: 'product_defect' | 'recording_limitation' | 'coverage_gap';
  readonly frame_indices: readonly number[];
  readonly log_excerpt: string;
  readonly severity: 'critical' | 'important' | 'minor';
  readonly title: string;
  readonly evidence: string;
  readonly recommendation: string;
}

interface AgentReview {
  readonly agent: string;
  readonly verdict: 'pass' | 'needs_changes' | 'unknown';
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
  readonly coverage_notes: string[];
}

interface FrameExtraction {
  readonly frames: readonly string[];
  readonly frameCount: number;
  readonly selectedFrameCount: number;
  readonly intervalSeconds: number;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function envValue(names: readonly string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return '';
}

function normalizeDotenvValue(value: string): string {
  let normalized = value.trim();
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1);
  }
  return normalized.trim();
}

function parseDotenvContents(contents: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const exportPrefix = 'export ';
    const normalizedLine = line.startsWith(exportPrefix) ? line.slice(exportPrefix.length).trim() : line;
    const separatorIndex = normalizedLine.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const key = normalizedLine.slice(0, separatorIndex).trim();
    const value = normalizeDotenvValue(normalizedLine.slice(separatorIndex + 1));
    if (key && value) {
      values.set(key, value);
    }
  }
  return values;
}

function dotenvFileValue(names: readonly string[]): string {
  const candidateFiles = [
    process.env.OPENAI_ENV_FILE,
    process.env.ENV_FILE,
    '.env',
    path.join(homedir(), 'example-dev.env'),
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);

  for (const filePath of [...new Set(candidateFiles)]) {
    if (!existsSync(filePath)) {
      continue;
    }
    const values = parseDotenvContents(readFileSync(filePath, 'utf8'));
    for (const name of names) {
      const value = values.get(name)?.trim();
      if (value) {
        return value;
      }
    }
  }
  return '';
}

function dotenvBase64Value(names: readonly string[]): string {
  const encoded = envValue(['SERVER_DEV_DOTENV_B64_SECRET', 'SERVER_DEV_DOTENV_B64']);
  if (!encoded) {
    return '';
  }

  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const values = parseDotenvContents(decoded);
  for (const name of names) {
    const value = values.get(name)?.trim();
    if (value) {
      return value;
    }
  }
  return '';
}

function fileSizeLabel(filePath: string): string {
  const bytes = statSync(filePath).size;
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function readTail(filePath: string, maxChars = MAX_LOG_CHARS): string {
  if (!filePath || !existsSync(filePath)) {
    return '';
  }

  const contents = readFileSync(filePath, 'utf8');
  if (contents.length <= maxChars) {
    return contents;
  }

  return contents.slice(contents.length - maxChars);
}

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const marker = '\n... omitted middle of long xcodebuild evidence timeline ...\n';
  const availableChars = Math.max(0, maxChars - marker.length);
  const headChars = Math.ceil(availableChars * 0.65);
  const tailChars = Math.floor(availableChars * 0.35);
  return `${text.slice(0, headChars)}${marker}${text.slice(text.length - tailChars)}`;
}

export function readOnboardingEvidenceTimeline(
  filePath: string,
  maxChars = MAX_EVIDENCE_TIMELINE_CHARS,
): string {
  if (!filePath || !existsSync(filePath)) {
    return '';
  }

  const evidencePatterns = [
    /Test Case '.*OnboardingFullFlowUITests.*(started|passed|failed)/,
    /Added attachment named '/,
    /\[PAGE\]/,
    /\*\* TEST EXECUTE (SUCCEEDED|FAILED) \*\*/,
  ];
  const lines = readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => evidencePatterns.some((pattern) => pattern.test(line)));

  return truncateMiddle(lines.join('\n'), maxChars);
}

function commandOutput(command: string, args: readonly string[]): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024 * 16,
  }).trim();
}

function parseDurationSeconds(videoPath: string): number {
  const rawDuration = commandOutput('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    videoPath,
  ]);
  const duration = Number(rawDuration);
  if (!Number.isFinite(duration) || duration <= 0) {
    return 0;
  }
  return duration;
}

function selectEvenly<T>(items: readonly T[], limit: number): readonly T[] {
  if (items.length <= limit) {
    return items;
  }

  const selected: T[] = [];
  const selectedIndexes = new Set<number>();
  for (let index = 0; index < limit; index += 1) {
    const scaledIndex = Math.round((index * (items.length - 1)) / (limit - 1));
    if (!selectedIndexes.has(scaledIndex)) {
      selectedIndexes.add(scaledIndex);
      const item = items[scaledIndex];
      if (item !== undefined) selected.push(item);
    }
  }
  return selected;
}

function extractVideoFrames(videoPath: string, durationSeconds: number): FrameExtraction {
  const maxFrames = Number(process.env.ONBOARDING_VIDEO_REVIEW_MAX_FRAMES || DEFAULT_MAX_FRAMES);
  const frameWidth = Number(process.env.ONBOARDING_VIDEO_REVIEW_FRAME_WIDTH || DEFAULT_FRAME_WIDTH);
  const explicitInterval = Number(process.env.ONBOARDING_VIDEO_REVIEW_FRAME_INTERVAL_SECONDS || 0);
  const intervalSeconds = explicitInterval > 0
    ? explicitInterval
    : Math.max(1, (durationSeconds || maxFrames * 10) / maxFrames);
  const framesDir = mkdtempSync(path.join(tmpdir(), 'onboarding-video-review-'));
  const framePattern = path.join(framesDir, 'frame_%05d.png');

  execFileSync('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-i',
    videoPath,
    '-vf',
    `fps=1/${intervalSeconds},scale=${frameWidth}:-1`,
    framePattern,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024 * 16,
  });

  const extractedFrames = readdirSync(framesDir)
    .filter((fileName) => fileName.endsWith('.png'))
    .sort((left, right) => left.localeCompare(right))
    .map((fileName) => path.join(framesDir, fileName));
  const selectedFrames = selectEvenly(extractedFrames, maxFrames);

  if (selectedFrames.length === 0) {
    throw new Error(`No frames were extracted from ${videoPath}`);
  }

  return {
    frames: selectedFrames,
    frameCount: extractedFrames.length,
    selectedFrameCount: selectedFrames.length,
    intervalSeconds,
  };
}

function responseText(responseBody: unknown): string {
  const response = record(responseBody);
  if (typeof response?.['output_text'] === 'string') {
    return response['output_text'];
  }

  const chunks: string[] = [];
  const output = response?.['output'];
  for (const item of Array.isArray(output) ? output : []) {
    const contentItems = record(item)?.['content'];
    for (const content of Array.isArray(contentItems) ? contentItems : []) {
      const text = record(content)?.['text'];
      if (typeof text === 'string') {
        chunks.push(text);
      }
    }
  }
  return chunks.join('\n').trim();
}

export function parseReviewJson(agentName: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(text.slice(firstBrace, lastBrace + 1));
      } catch {
        // Fall through to the structured failure below.
      }
    }
  }

  return {
    agent: agentName,
    verdict: 'unknown',
    summary: 'The review agent did not return parseable JSON.',
    findings: [],
    coverage_notes: ['Review output could not be validated; human triage is required.'],
  };
}

function normalizeFinding(rawFinding: unknown, context: Partial<ReviewContext>): ReviewFinding | null {
  const candidate = record(rawFinding);
  if (candidate === undefined) return null;
  const severity = candidate['severity'];
  const kind = candidate['kind'];
  if (typeof severity !== 'string' || !['critical', 'important', 'minor'].includes(severity)) return null;
  if (!['title', 'evidence', 'recommendation'].every(key => (
    typeof candidate[key] === 'string' && candidate[key].trim().length > 0
  ))) return null;
  if (typeof kind !== 'string' || !['product_defect', 'recording_limitation', 'coverage_gap'].includes(kind)) return null;
  const frameIndices = candidate['frame_indices'] ?? [];
  const logExcerpt = candidate['log_excerpt'] ?? '';
  if (!Array.isArray(frameIndices) || typeof logExcerpt !== 'string') return null;
  if (kind === 'product_defect') {
    if (!frameIndices.length && !logExcerpt) return null;
    if (frameIndices.some((index: unknown) => typeof index !== 'number'
      || !Number.isInteger(index) || index < 1
      || !Number.isInteger(context.selectedFrameCount)
      || context.selectedFrameCount === undefined
      || index > context.selectedFrameCount)) return null;
    if (logExcerpt && (logExcerpt.length < 12 || !context.xcodebuildEvidenceTimeline?.includes(logExcerpt))) return null;
  }
  if (!frameIndices.every((index: unknown): index is number => typeof index === 'number')) return null;
  const title = candidate['title'];
  const evidence = candidate['evidence'];
  const recommendation = candidate['recommendation'];
  if (typeof title !== 'string' || typeof evidence !== 'string' || typeof recommendation !== 'string') return null;
  return {
    kind: kind as ReviewFinding['kind'],
    frame_indices: frameIndices,
    log_excerpt: logExcerpt,
    id: typeof candidate['id'] === 'string' ? candidate['id'] : 'unknown',
    severity: severity as ReviewFinding['severity'],
    title: title.trim(),
    evidence: evidence.trim(),
    recommendation: recommendation.trim(),
  };
}

export function normalizeReview(
  agentName: string,
  rawReview: unknown,
  context: Partial<ReviewContext> = {},
): AgentReview {
  const candidate = record(rawReview);
  const candidateFindings = candidate?.['findings'];
  const rawFindings = Array.isArray(candidateFindings) ? candidateFindings : [];
  const validated = rawFindings.map(finding => normalizeFinding(finding, context)).filter(Boolean);
  const validFindings = validated.filter((finding): finding is ReviewFinding => finding !== null);
  const findings = validFindings.filter(finding => finding.kind === 'product_defect');
  const limitations = validFindings.filter(finding => finding.kind !== 'product_defect');
  const verdict = candidate?.['verdict'];
  const malformed = !Array.isArray(candidateFindings) || validFindings.length !== rawFindings.length
    || typeof verdict !== 'string' || !['pass', 'needs_changes'].includes(verdict);
  const candidateCoverage = candidate?.['coverage_notes'];
  const coverageNotes = Array.isArray(candidateCoverage)
    ? candidateCoverage.filter((note: unknown): note is string => typeof note === 'string') : [];
  coverageNotes.push(...limitations.map(finding => `${finding.kind}: ${finding.title}. ${finding.evidence} Follow-up: ${finding.recommendation}`));
  if (malformed) coverageNotes.push('Some review output was invalid; human triage is required.');
  return {
    agent: agentName,
    verdict: malformed || limitations.length ? 'unknown' : verdict as 'pass' | 'needs_changes',
    summary: typeof candidate?.['summary'] === 'string' ? candidate['summary'].trim() : '',
    findings,
    coverage_notes: coverageNotes,
  };
}

function approximateFrameSecond(index: number, frameCount: number, durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || frameCount <= 1) {
    return index;
  }
  return Math.round((index * durationSeconds) / (frameCount - 1));
}

const developmentOnboardingContract = `1. Test setup creates a pre-confirmed test user through the development backend. The user-facing evidence starts at Welcome, taps Log In, enters that user's email/password, and reaches the subscription paywall. Do not require visible sign-up or OTP UI for this test; do require visible login and post-login transition.
2. Subscription paywall is displayed. StoreKit purchase success is simulated by a test-only UI affordance/flag, but the paywall, trial CTA, and advance into profile activation must still be visible.
3. Profile activation collects visible financial/profile answers and hands off to Cash Savings.
4. Cash Savings activation goes through visible Plaid sandbox screens and returns to Example with linked-account state.
5. Debt can be activated by visible auto-routing from liabilities linked during Cash Savings Plaid. This is acceptable when the video shows liabilities/debt accounts linked to Debt, then the Debt card activated with a balance or the Debt dashboard/balance. Do not require a separate Debt-specific Plaid flow when that auto-route evidence is visible.
6. Budget & Spending auto-activates from the already-linked Cash + Debt accounts. Do not require a standalone budget setup wizard; do require visible Budget activation/confirmation or dashboard state that proves the budget card is no longer blocked.
7. The authenticated product dashboard, tab bar, net worth/account/card state, and no-paywall postcondition are visible after the core onboarding cards.
8. The guided tour is offered only after onboarding, starts only after user opt-in, and is visibly completed or dismissed into the dashboard. The opt-in card says "Take a quick tour?" with "Not Now" and "Start Tour". A later card titled "Tour complete" with "Get Started" / "Explore on My Own" is the tour completion card, not the pre-tour opt-in.
9. After the main onboarding journey, this test intentionally runs a post-onboarding #2895 chat-history privacy guard: seed a chat marker for the first user, sign out, return to Welcome, log in as a second fresh pre-confirmed user, and assert the prior user's marker is absent. Do not flag this public Welcome/login sequence as an unexpected session reset if it happens after the completed onboarding/dashboard/tour portion; evaluate it as a separate privacy guard.
10. Investments activation may run after the guided tour as an additional post-onboarding regression guard. Treat it as extra coverage, not as part of the core onboarding gate.`;

const productionOnboardingContract = `1. A guarded CI step pre-provisions two run-scoped users in production. The visible journey starts at Welcome, taps Log In, enters the first user's credentials, and reaches Profile activation. Do not require visible sign-up or OTP UI.
2. Required Profile setup completes before the deferred subscription paywall appears. The annual offer, eligibility-accurate CTA and renewal disclosure, simulated StoreKit purchase, and direct handoff into Cash Savings must be visible. A StoreKit user eligible for the introductory offer shows "Start Free Trial" with an explicit free-trial-to-paid transition, localized annual price, yearly cadence, and cancellation terms; an ineligible StoreKit user shows "Subscribe" with localized annual price, yearly cadence, automatic-renewal wording, and cancellation terms. Do not treat an eligibility-accurate "Subscribe" CTA as a blocker, and do not require the development-only paywall-before-Profile order or deliberate paywall Back-cycle regression detour.
3. Production Plaid cannot accept Sandbox institutions. Cash Savings and Debt therefore use the supported visible manual-account path with "Production E2E Savings" ($12,500) and "Production E2E Credit Card" ($1,200). Manual entry is required evidence here; do not require or recommend Plaid Sandbox screens.
4. Manual accounts intentionally do not create transaction-backed Budget scope. Budget & Spending must remain on the "About Budget" account-linking surface, must not open an activated Budget dashboard, and may remain labeled "Waiting for accounts". Treat that as the required production state, not a blocker.
5. Because manual-only production onboarding does not complete the development core-card contract, the guided tour must not be offered or auto-started. The absence of "Take a quick tour?", "Start Tour", and the tour overlay is required evidence.
6. The production dashboard must show loaded Net Worth values of $11,300, $12,500 assets, and $1,200 liabilities. Liabilities may render loaded or activated-with-no-data, while Spending must remain activation-required. Do not require transaction-backed Budget data or a Plaid liability detail state.
7. Income & Employment activation is additional production coverage. The first user's chat marker is then seeded, the user signs out, and the second pre-provisioned user logs in; the first marker must not be visible to the second user.
8. Evaluate visible defects and evidence gaps against this production-specific contract. Do not convert intentional differences from the development/Plaid contract into blocking findings.`;

export function promptForAgent(agentName: string, agentFocus: string, context: ReviewContext): string {
  const onboardingContract = context.isProductionE2E
    ? productionOnboardingContract
    : developmentOnboardingContract;
  const infrastructureNotes = context.isProductionE2E
    ? '- The test uses guarded, pre-provisioned production identities and the real production API.\n- Production uses manual Cash/Debt accounts because Plaid Production rejects Sandbox institutions.\n- StoreKit introductory-offer eligibility belongs to the Apple test account, not the newly provisioned Example identity; either eligibility-aware CTA is valid when its disclosure matches.'
    : '- The test uses a development backend and a test OTP endpoint to create a confirmed user.\n- Cash and Debt use Plaid Sandbox institutions.';
  return `You are the ${agentName} Codex review agent for the Example iOS full onboarding E2E test.

Review the sampled frames from the compressed simulator video, the xcodebuild evidence timeline, and the xcodebuild log tail. The sampled frames are extracted only from the compressed simulator video recorded during OnboardingFullFlowUITests.testFullOnboardingFlow.
Each image is preceded by a chronological frame label. Review frames in the order they are provided; later frames happen later in the same compressed video.

Focus:
${agentFocus}

Actual test contract to review against:
${onboardingContract}

Known test infrastructure that must be evaluated, not ignored:
${infrastructureNotes}
- The test may use StoreKit simulation flags for purchase success and entitlement refresh.
- These flags are acceptable only if the user-facing screens are still visible and the test cannot pass while skipping the product journey it claims to cover.
- Long home-screen segments before the app launch or after test teardown are not blockers when the app journey itself is visible. They are evidence-quality notes only.
- XCTest accessibility-query log lines mentioning "firstMatch" or missing alternate labels are not automatically bugs. Treat them as blocking only when the video/log shows the test actually navigated through an unintended generic fallback or bypassed a required screen.
- The xcodebuild evidence timeline is generated from the full xcodebuild log and includes chronological XCTest screenshot attachment names, page markers, and pass/fail lines. Use it to avoid false negatives when a required screen transition is too fast for the sampled video frames but the surrounding video flow and named XCTest attachments prove that the test reached and captured that screen.

Review constraints:
- Use the sampled video frames as the only visual evidence. Use the xcodebuild evidence timeline only as corroborating test evidence; do not invent visual details that are not present in sampled frames or named screenshot attachments.
- Call out any false-positive risk, missing assertion risk, bypassed user journey, visible bug, confusing UX, accessibility risk, stuck loading state, broken sequencing, or evidence gap.
- If sampled frames miss a fast required step, do not mark it blocking solely for missing sampled frames when the evidence timeline proves the XCTest captured the required screen and the video shows the surrounding journey.
- Do not recommend screenshot attachments. If video evidence is insufficient, recommend denser video sampling, cleaner video recording, or video-visible assertions.
- Use "needs_changes" for defects that warrant a GitHub follow-up issue. Video-review findings are advisory and never block the build; executable E2E assertions remain the release gate.
- Classify every finding as product_defect, recording_limitation, or coverage_gap. Missing sampled frames, compression, notifications and an unexecuted journey are limitations/gaps, not proof of a product defect.
- A product_defect must cite existing 1-based frame_indices from the provided sampled frames and/or an exact log_excerpt copied from the supplied evidence timeline. Never cite a frame outside the supplied recording or invent a log excerpt. All findings still require human verification.
- Return strict JSON only. No markdown, no prose outside JSON.

Return this shape:
{
  "agent": "${agentName}",
  "verdict": "pass" or "needs_changes",
  "summary": "One concise paragraph.",
  "findings": [
    {
      "id": "A catalog id or unknown",
      "kind": "product_defect" or "recording_limitation" or "coverage_gap",
      "frame_indices": [1],
      "log_excerpt": "Exact evidence-timeline excerpt or empty string",
      "severity": "critical" or "important" or "minor",
      "title": "Short title",
      "evidence": "What the video/log shows.",
      "recommendation": "Concrete fix or follow-up."
    }
  ],
  "coverage_notes": [
    "Short note about one covered or not-covered expected journey step."
  ]
}

Finding identity catalog (choose an exact id only when the condition matches; otherwise use "unknown"):
${Object.entries(VIDEO_FINDING_IDENTITIES).map(([id, entry]) => `- ${id}: ${entry.description}`).join('\n')}
Unknown ids remain advisory triage; never invent an id or match by title alone.

Run context:
- GitHub run: ${context.runUrl || 'local'}
- Video: ${context.videoPath}
- Video size: ${context.videoSize}
- Video duration seconds: ${context.durationSeconds.toFixed(1)}
- Sampled frames: ${context.selectedFrameCount} of ${context.frameCount}, every ${context.intervalSeconds}s
- Result bundle: ${context.resultBundlePath || 'not provided'}

xcodebuild evidence timeline:
\`\`\`
${context.xcodebuildEvidenceTimeline || 'No xcodebuild evidence timeline was available.'}
\`\`\`

xcodebuild log tail:
\`\`\`
${context.xcodebuildLogTail || 'No xcodebuild log tail was available.'}
\`\`\``;
}

async function callOpenAI({ apiKey, model, agentName, agentFocus, frames, context }: {
  readonly apiKey: string;
  readonly model: string;
  readonly agentName: string;
  readonly agentFocus: string;
  readonly frames: readonly string[];
  readonly context: ReviewContext;
}): Promise<AgentReview> {
  const content = [
    {
      type: 'input_text',
      text: promptForAgent(agentName, agentFocus, context),
    },
    ...frames.flatMap((framePath, index) => [
      {
        type: 'input_text',
        text: `Video frame ${index + 1} of ${frames.length}, chronological order, approx ${approximateFrameSecond(index, frames.length, context.durationSeconds)}s into the compressed video.`,
      },
      {
        type: 'input_image',
        image_url: `data:image/png;base64,${readFileSync(framePath).toString('base64')}`,
        detail: 'low',
      },
    ]),
  ];
  const payload: {
    model: string;
    input: readonly unknown[];
    max_output_tokens: number;
    reasoning?: { readonly effort: 'low' };
  } = {
    model,
    input: [
      {
        role: 'user',
        content,
      },
    ],
    max_output_tokens: 2600,
  };

  if (model === 'gpt-5.6-sol' || model.startsWith('gpt-5.5')) {
    payload.reasoning = { effort: 'low' };
  }

  let response: Response;
  try {
    response = await fetch(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (error: unknown) {
    const causeValue = error instanceof Error ? record(error.cause)?.['message'] : undefined;
    const cause = typeof causeValue === 'string' ? ` Cause: ${causeValue}` : '';
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${agentName} review failed before the OpenAI API returned a response. ` +
      `Model=${model}, frames=${frames.length}, frameWidth=${process.env.ONBOARDING_VIDEO_REVIEW_FRAME_WIDTH || DEFAULT_FRAME_WIDTH}, ` +
      `duration=${context.durationSeconds.toFixed(1)}s.${cause} ${message}`.trim()
    );
  }

  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `${agentName} review failed: OpenAI API returned ${response.status} ${JSON.stringify(responseBody)}`
    );
  }

  const text = responseText(responseBody);
  const parsed = parseReviewJson(agentName, text);
  return normalizeReview(agentName, parsed, context);
}

export function hasBlockingFindings(reviews: readonly AgentReview[]): boolean {
  return reviews.some((review) => (
    review.verdict === 'needs_changes' ||
    review.findings.some((finding) => finding.severity === 'critical')
  ));
}

export function renderFindings(findings: readonly ReviewFinding[]): string {
  if (findings.length === 0) {
    return 'No findings reported.';
  }

  return findings.map((finding, index) => [
    `${index + 1}. **${finding.severity.toUpperCase()}: ${finding.title}**`,
    `   Evidence: ${finding.evidence}`,
    ...(finding.frame_indices?.length ? [`   Sampled frame references (1-based): ${finding.frame_indices.join(', ')}`] : []),
    ...(finding.log_excerpt ? [`   Exact evidence-timeline excerpt: ${finding.log_excerpt}`] : []),
    `   Recommendation: ${finding.recommendation}`,
  ].join('\n')).join('\n');
}

export function reviewStatus(reviews: readonly AgentReview[]): 'unknown' | 'needs_changes' | 'pass' {
  return reviews.some(review => review.verdict === 'unknown') ? 'unknown' : hasBlockingFindings(reviews) ? 'needs_changes' : 'pass';
}

function renderReviewMarkdown({ model, reviews, context, blocking }: {
  readonly model: string;
  readonly reviews: readonly AgentReview[];
  readonly context: ReviewContext;
  readonly blocking: boolean;
}): string {
  const artifactName = `onboarding-e2e-review-${context.runId || 'local'}-${context.runAttempt || '0'}`;
  const runLine = context.runUrl ? `[${context.runId}/${context.runAttempt}](${context.runUrl})` : 'local run';
  const sections = reviews.map((review) => `### ${review.agent} agent
Verdict: **${review.verdict.toUpperCase()}**

${review.summary || 'No summary supplied.'}

${renderFindings(review.findings)}

Coverage notes:
${review.coverage_notes.length > 0 ? review.coverage_notes.map((note) => `- ${note}`).join('\n') : '- No coverage notes supplied.'}`);

  return `<!-- onboarding-e2e-video-review run=${context.runId || 'local'} attempt=${context.runAttempt || '0'} -->
${REVIEW_HEADING}

Status: **${reviewStatus(reviews) === 'unknown' ? 'UNKNOWN — HUMAN TRIAGE REQUIRED (NON-BLOCKING)' : blocking ? 'FOLLOW-UP REQUIRED (NON-BLOCKING)' : 'PASS'}**

Run: ${runLine}
Model: \`${model}\`
Source: compressed simulator video from \`OnboardingFullFlowUITests.testFullOnboardingFlow\`
Artifact: \`${artifactName}\`
Video: \`${path.basename(context.videoPath)}\` (${context.videoSize}, ${context.durationSeconds.toFixed(1)}s)
Review input: ${context.selectedFrameCount} chronologically labeled sampled frames extracted only from the compressed video, plus the xcodebuild evidence timeline and log tail.

${sections.join('\n\n')}
`;
}

async function postPrComment(markdown: string): Promise<boolean> {
  const token = envValue(['GITHUB_TOKEN']);
  const repo = envValue(['GITHUB_REPOSITORY']);
  const prNumber = envValue(['PR_NUMBER', 'REVIEW_PR_NUMBER']);

  if (!token || !repo || !prNumber) {
    return false;
  }

  const response = await fetch(`https://api.github.com/repos/${repo}/issues/${prNumber}/comments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ body: markdown }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`GitHub PR comment failed: ${response.status} ${JSON.stringify(body)}`);
  }

  return true;
}

export async function openOrUpdateFindingIssues({ reviews, context, model }: {
  readonly reviews: readonly AgentReview[];
  readonly context: ReviewContext;
  readonly model: string;
}): Promise<string[]> {
  void reviews;
  void model;
  if (process.env.ONBOARDING_VIDEO_ISSUE_FILING_ENABLED !== '1') {
    console.log('Issue filing disabled; findings remain advisory artifacts and PR comments.');
    return [];
  }
  if (!context.isProductionE2E || process.env.GITHUB_REF !== 'refs/heads/main') {
    console.warn('Issue filing is restricted to trusted production review runs.');
    return [];
  }
  // Migration inventory and the serialized writer are not yet complete.
  console.warn('Issue writes remain held pending canonical migration and serialized writer rollout.');
  return [];
}

export async function main(): Promise<void> {
  const videoPath = envValue(['ONBOARDING_E2E_COMPRESSED_VIDEO', 'COMPRESSED_VIDEO']);
  const apiKeyNames = [
    'OPENAI_API_KEY',
    'CODEX_OPENAI_API_KEY',
    'CODEX_API_KEY',
    'OPENAI_API_KEY_SECRET',
    'CODEX_OPENAI_API_KEY_SECRET',
    'CODEX_API_KEY_SECRET',
  ];
  const apiKey = envValue(apiKeyNames) || dotenvFileValue(apiKeyNames) || dotenvBase64Value(apiKeyNames);
  const model = envValue(['ONBOARDING_VIDEO_REVIEW_MODEL', 'OPENAI_REVIEW_MODEL', 'OPENAI_MODEL', 'OPENAI_CHAT_MODEL']) || 'gpt-5.6-sol';
  const reviewJsonPath = envValue(['REVIEW_JSON', 'ONBOARDING_E2E_REVIEW_JSON']);
  const reviewMarkdownPath = envValue(['REVIEW_MD', 'ONBOARDING_E2E_REVIEW_MD']);
  const xcodebuildLogPath = envValue(['ONBOARDING_E2E_XCODEBUILD_LOG', 'XCODEBUILD_LOG']);
  const resultBundlePath = envValue(['ONBOARDING_E2E_RESULT_BUNDLE', 'RESULT_BUNDLE']);

  if (!apiKey) {
    await postPrComment([
      '<!-- onboarding-e2e-video-review configuration-failure -->',
      REVIEW_HEADING,
      '',
      'Status: **CONFIGURATION FAILURE**',
      '',
      'The compressed onboarding video was produced, but the QA/UX Codex review could not run because no OpenAI/Codex API key was available to the GitHub step.',
      '',
      'Checked: `OPENAI_API_KEY`, `CODEX_OPENAI_API_KEY`, `CODEX_API_KEY`, `.env`, `$HOME/example-dev.env`, and `SERVER_DEV_DOTENV_B64`.',
    ].join('\n')).catch((commentError: unknown) => {
      const message = commentError instanceof Error ? commentError.message : String(commentError);
      console.error(`Failed to post missing-key PR comment: ${message}`);
    });
    throw new Error('No OpenAI API key found. Set OPENAI_API_KEY, CODEX_OPENAI_API_KEY, CODEX_API_KEY, or include one in SERVER_DEV_DOTENV_B64 / the runner dotenv.');
  }
  if (!videoPath || !existsSync(videoPath) || statSync(videoPath).size === 0) {
    throw new Error(`Compressed onboarding video is missing or empty: ${videoPath || '<unset>'}`);
  }

  const durationSeconds = parseDurationSeconds(videoPath);
  const frameExtraction = extractVideoFrames(videoPath, durationSeconds);
  const runId = envValue(['GITHUB_RUN_ID']);
  const runAttempt = envValue(['GITHUB_RUN_ATTEMPT']) || '0';
  const repo = envValue(['GITHUB_REPOSITORY']);
  const runUrl = repo && runId ? `https://github.com/${repo}/actions/runs/${runId}` : '';
  const context = {
    videoPath,
    videoSize: fileSizeLabel(videoPath),
    durationSeconds,
    frameCount: frameExtraction.frameCount,
    selectedFrameCount: frameExtraction.selectedFrameCount,
    intervalSeconds: frameExtraction.intervalSeconds,
    xcodebuildEvidenceTimeline: readOnboardingEvidenceTimeline(xcodebuildLogPath),
    xcodebuildLogTail: readTail(xcodebuildLogPath),
    resultBundlePath,
    runId,
    runAttempt,
    runUrl,
    repository: repo,
    commitSha: envValue(['GITHUB_SHA']),
    ref: envValue(['GITHUB_REF']),
    eventName: envValue(['GITHUB_EVENT_NAME']),
    isProductionE2E: envValue(['UI_TEST_PRODUCTION_E2E']) === '1',
  };

  const agentConfigs = [
    {
      agentName: 'QA',
      agentFocus: [
        '- Verify the sampled frames from the compressed video prove the test exercises the real end-to-end user journey.',
        '- Look for hidden skips, bypassed screens, missing assertions, false positives, brittle waits, or test-only flags that make the pass misleading.',
        '- Treat evidence gaps as findings when the compressed video does not prove the claimed journey.',
      ].join('\n'),
    },
    {
      agentName: 'UX',
      agentFocus: [
        '- Review the user-visible onboarding experience in the sampled video frames for broken sequencing, unreadable copy, stuck or jarring transitions, unexpected modals, consent problems, accessibility risk, and confusing product state.',
        '- Evaluate whether the resulting journey looks shippable to a real iOS user, not just whether XCTest passed.',
        '- Treat visual uncertainty as an evidence gap when the compressed video cannot prove the experience is acceptable.',
      ].join('\n'),
    },
  ];

  const reviews: AgentReview[] = [];
  for (const agentConfig of agentConfigs) {
    console.log(`Running ${agentConfig.agentName} onboarding video review with ${model}`);
    reviews.push(await callOpenAI({
      apiKey,
      model,
      agentName: agentConfig.agentName,
      agentFocus: agentConfig.agentFocus,
      frames: frameExtraction.frames,
      context,
    }));
  }

  const blocking = hasBlockingFindings(reviews);
  const result = {
    status: reviewStatus(reviews),
    model,
    context,
    reviews,
  };
  const markdown = renderReviewMarkdown({ model, reviews, context, blocking });

  if (reviewJsonPath) {
    mkdirSync(path.dirname(reviewJsonPath), { recursive: true });
    writeFileSync(reviewJsonPath, `${JSON.stringify(result, null, 2)}\n`);
  }
  if (reviewMarkdownPath) {
    mkdirSync(path.dirname(reviewMarkdownPath), { recursive: true });
    writeFileSync(reviewMarkdownPath, markdown);
  }

  const issueUrls = await openOrUpdateFindingIssues({ reviews, context, model }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Could not record onboarding video findings as GitHub issues: ${message}`);
    return [];
  });
  const issueSummary = issueUrls.length > 0
    ? `\n\nFollow-up issues:\n${issueUrls.map((url) => `- ${url}`).join('\n')}\n`
    : '';
  const didComment = await postPrComment(`${markdown}${issueSummary}`);
  console.log(didComment ? 'Posted onboarding video review PR comment' : 'No PR comment target was configured');
  console.log(markdown);

}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
