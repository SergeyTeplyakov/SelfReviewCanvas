// Review lifecycle: snapshots/revisions, threads, messages, delivery state, lessons.
// Pure persistence + domain logic; agent delivery and HTTP live elsewhere.
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import * as gitDefault from "./git.mjs";
import { relocate } from "./anchors.mjs";
import { hunkExcerpt, selectedLines } from "./diff.mjs";
import { ReviewError, isRecord } from "../web/contracts.mjs";
export { ReviewError } from "../web/contracts.mjs";
import type { Log, ReviewScope, DeliveryChoice } from "../../types/contracts.js";
import type { Store } from "./store.mjs";
import type { DiffFile, DiffSide } from "./diff.mjs";
import type { Snapshot } from "./git.mjs";
import type { AgentReviewRun, FindingMetadata } from "./agent-review.mjs";

export interface ReviewDescription {
    body: string;
    version: number;
    revisionId: string | null;
    updatedAt: string;
}

export interface MessageDelivery {
    state: "draft" | "saving" | "failed" | "queued" | "processing" | "no-reply" | "replied";
    attempts?: number;
    attemptId?: string;
    claimPid?: number;
    senderSessionId?: string;
    processedBy?: string;
    sessionMessageId?: string | null;
    batchId?: string;
    error?: string | null;
    updatedAt?: string;
    queuedAt?: string;
    processingAt?: string;
    repliedAt?: string;
}

export interface ReviewMessage {
    messageId: string;
    author: "user" | "agent";
    body: string;
    createdAt: string;
    clientRequestId?: string | null;
    delivery?: MessageDelivery;
    outcome?: string | null;
    verification?: string | null;
    inReplyTo?: string | null;
    lessonIds?: string[];
    descriptionContext?: ReviewDescription | null;
    reviewIntent?: "approve";
}

export interface ReviewAnchor {
    revisionId: string;
    path: string;
    oldPath?: string | null;
    side?: DiffSide;
    startLine?: number;
    endLine?: number;
    selectedLines?: string[];
    hunkHeader?: string | null;
    hunkText?: string | null;
}

export interface ReviewLocation extends ReviewAnchor {
    state: "current" | "outdated";
}

export interface ReviewThread {
    threadId: string;
    kind: string;
    status: string;
    author: "user" | "agent";
    createdAt: string;
    anchor: ReviewAnchor | null;
    location: ReviewLocation | null;
    messages: ReviewMessage[];
    agentReview?: FindingMetadata;
    ponytailReport?: { runId: string; revisionId: string };
}

export interface Lesson {
    lessonId: string;
    reviewId: string;
    threadId: string;
    messageId: string;
    scope: string;
    rule: string;
    status?: string;
    savedTo: string | null;
    createdAt: string;
    updatedAt?: string;
}

export interface ReviewRevision {
    revisionId: string;
    fingerprint: string;
    createdAt: string;
    headCommit: string;
    baseCommit: string;
    files: number;
    additions: number;
    deletions: number;
}

export interface Review {
    schema: number;
    reviewId: string;
    repoRoot: string;
    branch: string | null;
    originBranch?: string | null;
    title: string;
    base: string | null;
    paths: string[];
    exclude: string[];
    includeUntracked: boolean;
    contextLines: number;
    scope?: ReviewScope | "commit";
    currentRevisionId: string | null;
    revisions: ReviewRevision[];
    threads: ReviewThread[];
    lessons: Lesson[];
    git: {
        branch: string;
        headCommit: string;
        baseCommit: string;
        upstream: Snapshot["upstream"];
        uncommittedFiles: number;
        capturedAt: string;
    } | null;
    deliveryMode?: DeliveryChoice;
    agentReviews?: AgentReviewRun[];
    description?: ReviewDescription;
    siblingReviewId?: string;
    createdAt: string;
    updatedAt?: string;
    headCommit?: string;
    baseCommit?: string;
}

export interface OpenReviewInput {
    reviewId?: string;
    scope?: unknown;
    repoPath?: string;
    base?: string;
    title?: string;
    paths?: string[];
    exclude?: string[];
    includeUntracked?: boolean;
    context?: number;
}

export interface LessonInput {
    lessonId?: string;
    scope?: string;
    rule?: string;
    status?: string;
    savedTo?: string;
}

export interface MessageInput {
    body?: unknown;
    author?: unknown;
    clientRequestId?: unknown;
    hold?: unknown;
    outcome?: unknown;
    verification?: unknown;
    inReplyTo?: unknown;
    lessons?: unknown;
    descriptionVersion?: unknown;
}

export interface ThreadInput extends MessageInput {
    kind?: string;
    path?: string;
    side?: DiffSide;
    startLine?: number;
    endLine?: number;
    revisionId?: string;
}

export interface DeliveryClaim {
    attemptId: string;
    attempts: number;
}

export interface DraftClaim extends DeliveryClaim {
    threadId: string;
    messageId: string;
}

export type FileContent = { revisionId: string; path: string } & (
    { available: true; lines: string[] } |
    { available: false; reason: string; stale?: boolean }
);
export interface RefreshResult { revisionId: string; created: boolean; moved: number }
export interface ThreadResult { thread: ReviewThread; message: ReviewMessage; duplicate?: boolean }
type ReviewIdentity = { repoRoot: string; branch: string | null; base: string | null; paths?: string[]; exclude?: string[]; scope?: ReviewScope };
type NewReview = Required<Omit<ReviewIdentity, "scope">> & {
    reviewId: string; title: string; includeUntracked: boolean; contextLines: number;
    originBranch?: string | null; scope: ReviewScope;
};
const errorMessage = (error: unknown) => String(
    error && typeof error === "object" && "message" in error ? error.message ?? error : error,
);

export const THREAD_KINDS = ["overview", "file", "change", "line"];
export const THREAD_STATUSES = ["active", "resolved", "wontfix", "closed"];
export const OUTCOMES = ["answered", "changed", "blocked", "disagreed", "needs-input"];
export const LESSON_STATUSES = ["proposed", "saved", "declined"];
export const SCOPES: ReviewScope[] = ["all", "pending"];
const PENDING_SUFFIX = " (pending changes)";
const MAX_BODY = 20000;
const MAX_RANGE = 2000;
const MAX_ANCHOR_LINES = 400;
const MAX_FULL_FILE_LINES = 20000;

const invalid = (msg: string) => new ReviewError("invalid_input", msg);
const notFound = (msg: string) => new ReviewError("not_found", msg);

function slug(value: string) {
    return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}

// "all" reviews the whole branch or PR (working tree vs merge-base); "pending" reviews only uncommitted work (working tree vs HEAD).
export function checkScope(value: unknown): ReviewScope {
    if (value == null) return "all";
    if (value !== "all" && value !== "pending") throw invalid(`scope must be one of ${SCOPES.join(", ")}.`);
    return value;
}

// Reviews saved before scopes existed have no scope field and are "all" reviews.
export function scopeOf(review: Pick<Review, "scope"> | null | undefined): ReviewScope {
    return review?.scope === "pending" ? "pending" : "all";
}

// Historical single-commit reviews were removed; their records stay on disk but are never reopened as All or Pending reviews.
export function isRetiredCommitReview(review: Pick<Review, "scope"> | null | undefined) {
    return review?.scope === "commit";
}

export function retiredCommitError(review: Pick<Review, "reviewId">) {
    return new ReviewError("unsupported", `Review ${review.reviewId} is a historical single-commit review. That mode was removed; its local notes remain stored but it can no longer be opened. Open an All changes or Pending changes review instead.`);
}

// The "all" id must stay identical to the pre-scope computation so existing reviews keep their threads.
export function computeReviewId({ repoRoot, branch, base, paths = [], exclude = [], scope = "all" }: ReviewIdentity) {
    const parts = [path.resolve(repoRoot).toLowerCase(), branch, base, [...paths].sort().join(","), [...exclude].sort().join(",")];
    if (scope === "pending") parts.push("pending");
    const hash = createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 8);
    const label = scope === "pending" ? `${path.basename(repoRoot)}-${branch}-pending` : `${path.basename(repoRoot)}-${branch}-vs-${base}`;
    const readable = slug(label).slice(0, 80) || "review";
    return `${readable}-${hash}`;
}

function defaultTitle({ branch, base, scope }: Pick<Review, "branch" | "base" | "scope">) {
    return scope === "pending" ? `${branch}${PENDING_SUFFIX}` : `${branch} vs ${base}`;
}

function applyOpenOptions(review: Review, input: OpenReviewInput) {
    if (input.title) review.title = input.title;
    if (input.includeUntracked !== undefined) review.includeUntracked = input.includeUntracked;
    if (input.context !== undefined) review.contextLines = input.context;
    return review;
}

// A default title is regenerated for the target scope; a custom title is carried over with the pending suffix toggled.
function siblingTitle(source: Review, targetScope: ReviewScope) {
    const origin = source.originBranch ?? source.branch;
    if (source.title === defaultTitle({ branch: origin, base: source.base, scope: scopeOf(source) })) {
        return defaultTitle({ branch: source.branch, base: source.base, scope: targetScope });
    }
    const hasSuffix = source.title.endsWith(PENDING_SUFFIX);
    if (targetScope === "pending") return hasSuffix ? source.title : `${source.title}${PENDING_SUFFIX}`;
    return hasSuffix ? source.title.slice(0, -PENDING_SUFFIX.length) : source.title;
}

// originBranch is the branch the id was computed from; branch is the live label refreshed on every capture.
function newReviewRecord({ reviewId, title, repoRoot, base, paths, exclude, includeUntracked, contextLines, branch, originBranch = branch, scope }: NewReview): Review {
    return {
        schema: 1,
        reviewId,
        title,
        repoRoot,
        base,
        paths,
        exclude,
        includeUntracked,
        contextLines,
        branch,
        originBranch,
        scope,
        git: null,
        currentRevisionId: null,
        revisions: [],
        threads: [],
        lessons: [],
        createdAt: nowIso(),
    };
}

function nowIso() {
    return new Date().toISOString();
}

function checkBody(body: unknown) {
    if (typeof body !== "string" || !body.trim()) throw invalid("Comment body is required.");
    if (body.length > MAX_BODY) throw invalid(`Comment body exceeds ${MAX_BODY} characters.`);
    return body.trim();
}

function optionalString(value: unknown, name: string): string | undefined {
    if (value == null) return undefined;
    if (typeof value !== "string") throw invalid(`${name} must be a string.`);
    return value;
}

function lessonInput(value: unknown): LessonInput {
    if (!isRecord(value)) throw invalid("Each lesson needs a non-empty rule or the lessonId of an existing guideline.");
    const fields = value;
    const hasRule = typeof fields.rule === "string" && fields.rule.trim();
    if (!hasRule && !fields.lessonId) throw invalid("Each lesson needs a non-empty rule or the lessonId of an existing guideline.");
    if (fields.scope && fields.scope !== "repo" && fields.scope !== "personal") throw invalid("lesson.scope must be repo or personal.");
    if (fields.status != null && (typeof fields.status !== "string" || !LESSON_STATUSES.includes(fields.status))) {
        throw invalid(`lesson.status must be one of ${LESSON_STATUSES.join(", ")}.`);
    }
    return {
        lessonId: optionalString(fields.lessonId, "lesson.lessonId"),
        rule: typeof fields.rule === "string" ? fields.rule : undefined,
        scope: optionalString(fields.scope, "lesson.scope"),
        status: optionalString(fields.status, "lesson.status"),
        savedTo: optionalString(fields.savedTo, "lesson.savedTo"),
    };
}

function checkLine(value: unknown, name: string): asserts value is number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw invalid(`${name} must be a positive integer.`);
}

function allMessages(review: Review) {
    return review.threads.flatMap((t) => t.messages.map((m) => ({ thread: t, message: m })));
}

function findDuplicate(review: Review, clientRequestId?: unknown) {
    if (!clientRequestId) return null;
    return allMessages(review).find((e) => e.message.clientRequestId === clientRequestId) ?? null;
}

function findThread(review: Review, threadId: string) {
    const thread = review.threads.find((t) => t.threadId === threadId);
    if (!thread) throw notFound(`Thread ${threadId} not found in review ${review.reviewId}.`);
    return thread;
}

const normalizeRule = (rule: string) => rule.toLowerCase().replace(/\s+/g, " ").replace(/[\s.;:!,]+$/, "").trim();

// Records a guideline the agent reported. A decision on a guideline proposed earlier in the thread (by lessonId,
// or by the same rule text) updates that lesson in place instead of adding a duplicate. Lessons without a
// status are legacy records and count as saved.
function applyLesson(review: Review, { reviewId, threadId, messageId }: Pick<Lesson, "reviewId" | "threadId" | "messageId">, input: LessonInput) {
    const status = input.status ?? "saved";
    const rule = typeof input.rule === "string" ? input.rule.trim() : "";
    let lesson;
    if (input.lessonId) {
        lesson = review.lessons.find((l) => l.lessonId === input.lessonId && l.threadId === threadId);
        if (!lesson) throw notFound(`Lesson ${input.lessonId} not found in thread ${threadId}.`);
    } else {
        lesson = review.lessons.find((l) => l.threadId === threadId && (l.status ?? "saved") === "proposed" && normalizeRule(l.rule) === normalizeRule(rule));
    }
    if (!lesson) {
        lesson = {
            lessonId: `l-${randomUUID().slice(0, 8)}`,
            reviewId,
            threadId,
            messageId,
            scope: input.scope ?? "repo",
            rule,
            status,
            savedTo: status === "saved" ? input.savedTo ?? null : null,
            createdAt: nowIso(),
        };
        review.lessons.push(lesson);
        return lesson;
    }
    if (rule) lesson.rule = rule;
    if (input.scope) lesson.scope = input.scope;
    lesson.status = status;
    lesson.savedTo = status === "saved" ? input.savedTo ?? lesson.savedTo ?? null : null;
    lesson.updatedAt = nowIso();
    return lesson;
}

function revisionContent(file: DiffFile, oldLines: string[]): string[] | null {
    let oldIndex = 0;
    const lines: string[] = [];
    for (const hunk of file.hunks) {
        const oldStart = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
        const newStart = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1;
        if (oldStart < oldIndex || oldStart > oldLines.length || newStart - lines.length !== oldStart - oldIndex) return null;
        while (oldIndex < oldStart) {
            lines.push(oldLines[oldIndex++]);
        }
        for (const row of hunk.rows) {
            if (row.o != null) {
                if (row.o !== oldIndex + 1 || oldLines[oldIndex] !== row.s) return null;
                oldIndex++;
            }
            if (row.n != null) {
                if (row.n !== lines.length + 1) return null;
                lines.push(row.s);
            }
        }
        if (oldIndex !== oldStart + hunk.oldLines || lines.length !== newStart + hunk.newLines) return null;
    }
    return lines.concat(oldLines.slice(oldIndex));
}

function matchesRevision(file: DiffFile, oldLines: string[], newLines: string[]) {
    const lines = revisionContent(file, oldLines);
    return lines !== null && lines.length === newLines.length && lines.every((line, i) => line === newLines[i]);
}

// A draft is held by the reviewer and has not been offered to the agent yet.
const DELIVERY_RANK = { draft: -1, saving: 0, failed: 1, queued: 2, processing: 3, "no-reply": 4, replied: 5 };
const REVIEW_DELIVERY_CHOICES = ["immediate", "batch"];

// Signal 0 only probes the process; EPERM means it exists but belongs to another user.
function processAlive(pid: number) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err instanceof Error && "code" in err && err.code === "EPERM";
    }
}

export class ReviewService extends EventEmitter {
    readonly store: Store;
    readonly git: typeof gitDefault;
    readonly log: Log;
    readonly pid: number;
    readonly isProcessAlive: (pid: number) => boolean;
    private readonly refreshes: Map<string, { again: boolean; promise?: Promise<RefreshResult> }>;
    /**
     * @param {object} p
     * @param {number} [p.pid] process recorded on delivery claims
     * @param {(pid: number) => boolean} [p.isProcessAlive] whether a claiming process is still running
     */
    constructor({ store, git = gitDefault, log = () => {}, pid = process.pid, isProcessAlive = processAlive }: {
        store: Store; git?: typeof gitDefault; log?: Log; pid?: number; isProcessAlive?: (pid: number) => boolean;
    }) {
        super();
        this.store = store;
        this.git = git;
        this.log = log;
        this.pid = pid;
        this.isProcessAlive = isProcessAlive;
        this.refreshes = new Map();
    }

    changed(reviewId: string, reason: string) {
        this.emit("changed", { reviewId, reason });
    }

    async getReview(reviewId: string) {
        const review = await this.store.readReview(reviewId);
        if (!review) throw notFound(`Review ${reviewId} not found.`);
        return review;
    }

    async updateDescription(reviewId: string, { body, expectedVersion }: { body?: unknown; expectedVersion?: unknown }) {
        const text = checkBody(body);
        if (typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion) || expectedVersion < 0) throw invalid("expectedVersion must be a non-negative integer.");
        const description = await this.store.updateReview(reviewId, (review) => {
            if (!review) throw notFound(`Review ${reviewId} not found.`);
            if (isRetiredCommitReview(review)) throw retiredCommitError(review);
            const current = review.description;
            if ((current?.version ?? 0) !== expectedVersion) {
                throw new ReviewError("conflict", "Description changed. Read the current description before revising it.");
            }
            if (current?.body === text) return { write: false, value: current };
            review.description = { body: text, version: expectedVersion + 1, revisionId: review.currentRevisionId, updatedAt: nowIso() };
            return { review, value: review.description };
        });
        this.changed(reviewId, "description");
        return description;
    }

    descriptionContext(review: Review, input: Pick<MessageInput, "descriptionVersion">) {
        if (input.descriptionVersion !== undefined && input.descriptionVersion !== (review.description?.version ?? 0)) {
            throw new ReviewError("conflict", "Description changed since you read it. Refresh and review it before posting.");
        }
        return review.description ? { ...review.description } : null;
    }

    // Creates the review on first open, then captures a fresh snapshot.
    // An explicit scope that differs from an existing review's scope opens its sibling review instead.
    async ensureReview(input: OpenReviewInput = {}, { cwd = process.cwd() } = {}) {
        const requestedScope = input.scope == null ? null : checkScope(input.scope);
        if (input.reviewId) {
            const existing = await this.getReview(input.reviewId);
            if (isRetiredCommitReview(existing)) throw retiredCommitError(existing);
            const switching = requestedScope !== null && requestedScope !== scopeOf(existing);
            const reviewId = switching ? await this.openSibling(input.reviewId, requestedScope, { base: input.base }) : input.reviewId;
            const hasOptions = input.title || input.includeUntracked !== undefined || input.context !== undefined;
            if (hasOptions) {
                await this.store.updateReview(reviewId, (r) => {
                    if (!r) throw notFound(`Review ${reviewId} not found.`);
                    return { review: applyOpenOptions(r, input) };
                });
            }
            if (!switching || hasOptions) await this.refresh(reviewId);
            return reviewId;
        }

        let repoRoot;
        try {
            repoRoot = await this.git.resolveRepoRoot(input.repoPath || cwd);
        } catch (err) {
            throw invalid(`Not a git repository: ${input.repoPath || cwd} (${errorMessage(err)})`);
        }
        const scope = requestedScope ?? "all";
        const base = input.base || (scope === "pending" ? null : await this.git.defaultBase(repoRoot));
        const branch = (await this.git.runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
        const paths = input.paths ?? [];
        const exclude = input.exclude ?? [];
        const reviewId = computeReviewId({ repoRoot, branch, base, paths, exclude, scope });

        await this.store.updateReview(reviewId, (existing) => {
            if (existing) {
                return { review: applyOpenOptions(existing, input) };
            }
            return {
                review: newReviewRecord({
                    reviewId,
                    title: input.title || defaultTitle({ branch, base, scope }),
                    repoRoot,
                    base,
                    paths,
                    exclude,
                    includeUntracked: input.includeUntracked ?? true,
                    contextLines: input.context ?? 5,
                    branch,
                    scope,
                }),
            };
        });
        await this.refresh(reviewId);
        return reviewId;
    }

    // Opens the other-scope review of the same repository, branch, base, and pathspecs, creating it on first use.
    async openSibling(reviewId: string, scope: ReviewScope, { base: requestedBase }: { base?: string } = {}) {
        const target = checkScope(scope);
        const source = await this.getReview(reviewId);
        if (isRetiredCommitReview(source)) throw retiredCommitError(source);
        if (target === scopeOf(source)) return reviewId;
        if (source.siblingReviewId && !requestedBase) {
            await this.refresh(source.siblingReviewId);
            return source.siblingReviewId;
        }
        const base = requestedBase || source.base || (target === "all" ? await this.git.defaultBase(source.repoRoot) : null);
        const originBranch = source.originBranch ?? source.branch;
        const siblingId = computeReviewId({
            repoRoot: source.repoRoot,
            branch: originBranch,
            base,
            paths: source.paths,
            exclude: source.exclude,
            scope: target,
        });
        await this.store.updateReview(siblingId, (existing) => {
            if (existing) return { review: Object.assign(existing, { siblingReviewId: reviewId }) };
            return {
                review: { ...newReviewRecord({
                    reviewId: siblingId,
                    title: siblingTitle({ ...source, base }, target),
                    repoRoot: source.repoRoot,
                    base,
                    paths: source.paths,
                    exclude: source.exclude,
                    includeUntracked: source.includeUntracked,
                    contextLines: source.contextLines,
                    branch: source.branch,
                    originBranch,
                    scope: target,
                }), siblingReviewId: reviewId },
            };
        });
        await this.refresh(siblingId);
        await this.store.updateReview(reviewId, (review) => {
            if (!review) throw notFound(`Review ${reviewId} not found.`);
            return { review: Object.assign(review, { siblingReviewId: siblingId }) };
        });
        return siblingId;
    }

    // Coalesces overlapping refreshes; a refresh requested mid-capture triggers one more pass.
    refresh(reviewId: string): Promise<RefreshResult> {
        const running = this.refreshes.get(reviewId);
        if (running?.promise) {
            running.again = true;
            return running.promise;
        }
        const entry: { again: boolean; promise?: Promise<RefreshResult> } = { again: false };
        entry.promise = (async () => {
            try {
                let result;
                do {
                    entry.again = false;
                    result = await this.refreshOnce(reviewId);
                } while (entry.again);
                return result;
            } finally {
                this.refreshes.delete(reviewId);
            }
        })();
        this.refreshes.set(reviewId, entry);
        return entry.promise;
    }

    async refreshOnce(reviewId: string): Promise<RefreshResult> {
        const before = await this.getReview(reviewId);
        if (isRetiredCommitReview(before)) throw retiredCommitError(before);
        let snapshot;
        try {
            snapshot = await this.git.captureSnapshot({
                repoRoot: before.repoRoot,
                base: before.base,
                paths: before.paths,
                exclude: before.exclude,
                includeUntracked: before.includeUntracked,
                contextLines: before.contextLines,
                scope: scopeOf(before),
            });
        } catch (err) {
            throw new ReviewError("git_error", errorMessage(err));
        }

        const result = await this.store.updateReview(reviewId, async (review) => {
            if (!review) throw notFound(`Review ${reviewId} not found.`);
            const git = {
                branch: snapshot.branch,
                headCommit: snapshot.headCommit,
                baseCommit: snapshot.baseCommit,
                upstream: snapshot.upstream,
                uncommittedFiles: snapshot.uncommittedFiles.length,
                capturedAt: nowIso(),
            };
            const latest = review.revisions[review.revisions.length - 1];
            let created = false;
            let revisionId = latest?.revisionId;
            if (!latest || latest.fingerprint !== snapshot.fingerprint) {
                revisionId = `r${review.revisions.length + 1}`;
                const stats = snapshot.files.reduce((a, f) => ({ additions: a.additions + f.additions, deletions: a.deletions + f.deletions }), { additions: 0, deletions: 0 });
                await this.store.writeSnapshot(reviewId, revisionId, { revisionId, ...snapshot });
                review.revisions.push({
                    revisionId,
                    fingerprint: snapshot.fingerprint,
                    createdAt: nowIso(),
                    headCommit: snapshot.headCommit,
                    baseCommit: snapshot.baseCommit,
                    files: snapshot.files.length,
                    ...stats,
                });
                review.currentRevisionId = revisionId;
                created = true;
            }
            review.git = git;
            review.branch = snapshot.branch;
            const moved = await this.relocateThreads(review, revisionId!, snapshot.baseCommit);
            return { review, value: { revisionId: revisionId!, created, moved } };
        });
        if (result.created || result.moved) this.changed(reviewId, "revision");
        else this.changed(reviewId, "git");
        return result;
    }

    async relocateThreads(review: Review, revisionId: string | null, baseCommit?: string) {
        const cache = new Map<string, string[] | null>();
        const contentFor = async (side: DiffSide | undefined, filePath: string) => {
            const key = `${side}\0${filePath}`;
            if (!cache.has(key)) {
                cache.set(key, side === "old"
                    ? await this.git.readCommitFile(review.repoRoot, baseCommit!, filePath)
                    : await this.git.readWorkingFile(review.repoRoot, filePath));
            }
            return cache.get(key)!;
        };
        let moved = 0;
        for (const thread of review.threads) {
            if (!thread.location || thread.location.revisionId === revisionId) continue;
            if (thread.kind === "line" || thread.kind === "change") {
                const side = thread.location.side;
                const lines = await contentFor(side, side === "old" ? (thread.anchor!.oldPath ?? thread.anchor!.path) : thread.location.path);
                const next = relocate(thread.anchor as ReviewAnchor & { startLine: number; endLine: number }, thread.location.startLine!, lines);
                if (next.startLine !== thread.location.startLine || next.state !== thread.location.state) moved++;
                thread.location = { ...thread.location, ...next, revisionId: revisionId! };
            } else {
                thread.location = { ...thread.location, revisionId: revisionId! };
            }
        }
        return moved;
    }

    async getSnapshot(reviewId: string, revisionId?: string | null) {
        const review = await this.getReview(reviewId);
        const rev = revisionId ?? review.currentRevisionId;
        const snapshot = await this.store.readSnapshot(reviewId, rev);
        if (!snapshot) throw notFound(`Revision ${rev} not found for review ${reviewId}.`);
        return snapshot;
    }

    // Validate gaps against the saved base as well as hunks so newer edits cannot leak into an older revision.
    async getFileContent(reviewId: string, revisionId: string | null | undefined, filePath: string | null): Promise<FileContent> {
        const review = await this.getReview(reviewId);
        if (typeof filePath !== "string" || !filePath) throw invalid("path is required.");
        this.git.safeJoin(review.repoRoot, filePath);
        const rev = revisionId ?? review.currentRevisionId;
        const snapshot = await this.store.readSnapshot(reviewId, rev);
        if (!snapshot) throw notFound(`Revision ${rev} not found for review ${reviewId}.`);
        const file = snapshot.files.find((f) => f.path === filePath);
        if (!file) throw notFound(`${filePath} is not part of revision ${rev}.`);
        const base = { revisionId: rev!, path: filePath };
        if (file.binary) return { ...base, available: false, reason: "binary" };
        if (file.status === "deleted") return { ...base, available: false, reason: "deleted" };

        const lines = await this.git.readWorkingFile(review.repoRoot, filePath);
        if (!lines) return { ...base, available: false, reason: "missing", stale: true };
        const endsWithNewline = lines[lines.length - 1] === "";
        if (lines[lines.length - 1] === "") lines.pop();
        const finalRow = file.hunks.flatMap((h) => h.rows).find((r) => r.n === lines.length);
        if (finalRow && Boolean(finalRow.noNewlineAtEnd) === endsWithNewline) {
            return { ...base, available: false, reason: "stale", stale: true };
        }
        if (lines.length > MAX_FULL_FILE_LINES) return { ...base, available: false, reason: "too-large" };
        const oldLines = file.status === "added"
            ? []
            : await this.git.readCommitFile(review.repoRoot, snapshot.baseCommit, file.oldPath ?? file.path);
        if (!oldLines) return { ...base, available: false, reason: "base-unavailable" };
        if (oldLines[oldLines.length - 1] === "") oldLines.pop();
        if (oldLines.length > MAX_FULL_FILE_LINES) return { ...base, available: false, reason: "too-large" };
        if (!matchesRevision(file, oldLines, lines)) return { ...base, available: false, reason: "stale", stale: true };
        return { ...base, available: true, lines };
    }

    async buildAnchor(review: Review, { kind, path: filePath, side, startLine, endLine, revisionId }: Omit<ThreadInput, "body">): Promise<{ anchor: ReviewAnchor | null; location: ReviewLocation | null }> {
        if (kind === "overview") return { anchor: null, location: null };
        if (typeof filePath !== "string" || !filePath) throw invalid("path is required for file, change, and line threads.");
        this.git.safeJoin(review.repoRoot, filePath);
        const rev = revisionId ?? review.currentRevisionId;
        const snapshot = await this.store.readSnapshot(review.reviewId, rev);
        const file = snapshot?.files.find((f) => f.path === filePath) ?? null;
        if (!snapshot) throw notFound(`Revision ${rev} not found for review ${review.reviewId}.`);

        if (kind === "file") {
            const base = { revisionId: rev!, path: filePath, oldPath: file?.oldPath ?? null };
            return { anchor: base, location: { revisionId: rev!, path: filePath, state: "current" } };
        }
        if (!file) throw notFound(`${filePath} is not part of revision ${rev}.`);

        const s = side === "old" ? "old" : "new";
        checkLine(startLine, "startLine");
        const end = endLine ?? startLine;
        checkLine(end, "endLine");
        if (end < startLine) throw invalid("endLine must be >= startLine.");
        if (end - startLine + 1 > MAX_RANGE) throw invalid(`Range exceeds ${MAX_RANGE} lines.`);

        let selected = file ? selectedLines(file, s, startLine, end) : [];
        if (selected.length !== end - startLine + 1) {
            const content = s === "old"
                ? await this.git.readCommitFile(review.repoRoot, snapshot.baseCommit, file.oldPath ?? filePath)
                : await this.revisionLines(review.reviewId, rev!, filePath);
            if (!content || end > content.length) throw invalid(`Lines ${startLine}-${end} are outside ${filePath} (${s} side).`);
            selected = content.slice(startLine - 1, end);
        }
        const excerpt = file ? hunkExcerpt(file, s, startLine, end) : null;
        const anchor: ReviewAnchor = {
            revisionId: rev!,
            path: filePath,
            oldPath: file?.oldPath ?? null,
            side: s,
            startLine,
            endLine: end,
            selectedLines: selected.slice(0, MAX_ANCHOR_LINES),
            hunkHeader: excerpt?.header ?? null,
            hunkText: excerpt?.text ?? null,
        };
        return { anchor, location: { revisionId: rev!, path: filePath, side: s, startLine, endLine: end, state: "current" } };
    }

    async buildThread(review: Review, input: ThreadInput): Promise<ThreadResult> {
        if (isRetiredCommitReview(review)) throw retiredCommitError(review);
        const kind = input.kind ?? "line";
        if (!THREAD_KINDS.includes(kind)) throw invalid(`kind must be one of ${THREAD_KINDS.join(", ")}.`);
        const author = input.author === "agent" ? "agent" : "user";
        const body = checkBody(input.body);
        const { anchor, location } = await this.buildAnchor(review, { ...input, kind });
        const message: ReviewMessage = {
            messageId: `m-${randomUUID()}`,
            author,
            body,
            createdAt: nowIso(),
            clientRequestId: optionalString(input.clientRequestId, "clientRequestId") ?? null,
            ...(author === "user" ? { delivery: input.hold ? { state: "draft", attempts: 0 } : { state: "saving", attempts: 0, claimPid: this.pid } } : { outcome: optionalString(input.outcome, "outcome") ?? null }),
            ...(kind === "overview" ? { descriptionContext: this.descriptionContext(review, input) } : {}),
        };
        const thread: ReviewThread = {
            threadId: `t-${randomUUID().slice(0, 8)}`,
            kind,
            status: "active",
            author,
            createdAt: nowIso(),
            anchor,
            location,
            messages: [message],
        };
        return { thread, message };
    }

    async createThread(reviewId: string, input: ThreadInput): Promise<ThreadResult> {
        const result = await this.store.updateReview(reviewId, async (review) => {
            if (!review) throw notFound(`Review ${reviewId} not found.`);
            const dup = findDuplicate(review, input.clientRequestId);
            if (dup) return { write: false, value: { thread: dup.thread, message: dup.message, duplicate: true } };
            const { thread, message } = await this.buildThread(review, input);
            review.threads.push(thread);
            if (thread.location && thread.location.revisionId !== review.currentRevisionId) {
                await this.relocateThreads(review, review.currentRevisionId, review.git?.baseCommit);
            }
            return { review, value: { thread, message, duplicate: false } };
        });
        this.changed(reviewId, "thread");
        return result;
    }

    async addMessage(reviewId: string, threadId: string, input: MessageInput): Promise<ThreadResult> {
        const author = input.author === "agent" ? "agent" : "user";
        const body = checkBody(input.body);
        if (author === "agent" && input.outcome && (typeof input.outcome !== "string" || !OUTCOMES.includes(input.outcome))) {
            throw invalid(`outcome must be one of ${OUTCOMES.join(", ")}.`);
        }
        const lessonsInput = Array.isArray(input.lessons) ? input.lessons.map((value: unknown) => lessonInput(value)) : [];

        const touchedLessons = new Map<string, Lesson>();
        const result = await this.store.updateReview(reviewId, async (review) => {
            if (!review) throw notFound(`Review ${reviewId} not found.`);
            if (isRetiredCommitReview(review)) throw retiredCommitError(review);
            const dup = findDuplicate(review, input.clientRequestId);
            if (dup) return { write: false, value: { thread: dup.thread, message: dup.message, duplicate: true } };
            const thread = findThread(review, threadId);

            const message: ReviewMessage = {
                messageId: `m-${randomUUID()}`,
                author,
                body,
                createdAt: nowIso(),
                clientRequestId: optionalString(input.clientRequestId, "clientRequestId") ?? null,
                ...(thread.kind === "overview" && author === "user" ? { descriptionContext: this.descriptionContext(review, input) } : {}),
            };
            if (author === "user") {
                message.delivery = input.hold ? { state: "draft", attempts: 0 } : { state: "saving", attempts: 0, claimPid: this.pid };
                if (thread.status !== "active") thread.status = "active";
            } else {
                message.outcome = optionalString(input.outcome, "outcome") ?? null;
                message.verification = optionalString(input.verification, "verification") ?? null;
                message.inReplyTo = optionalString(input.inReplyTo, "inReplyTo") ?? null;
                const target = input.inReplyTo
                    ? thread.messages.find((m) => m.messageId === input.inReplyTo)
                    : [...thread.messages].reverse().find((m) => m.author === "user" && m.delivery && !["replied", "draft"].includes(m.delivery.state));
                if (input.inReplyTo && !target) throw notFound(`Message ${input.inReplyTo} not found in thread ${threadId}.`);
                if (target?.delivery?.state === "draft") {
                    throw new ReviewError("conflict", `Message ${input.inReplyTo} is a draft the reviewer has not sent yet; reply after it is delivered.`);
                }
                if (target?.delivery) {
                    const repliedAt = nowIso();
                    target.delivery = { ...target.delivery, state: "replied", repliedAt };
                    // One reply answers every comment the same submitted review added to this thread.
                    const batchId = target.delivery.batchId;
                    for (const m of batchId ? thread.messages : []) {
                        if (m !== target && m.author === "user" && m.delivery?.batchId === batchId && m.delivery?.state !== "replied") {
                            m.delivery = { ...m.delivery, state: "replied", repliedAt };
                        }
                    }
                }
                message.lessonIds = [];
                for (const l of lessonsInput) {
                    const lesson = applyLesson(review, { reviewId, threadId, messageId: message.messageId }, l);
                    if (!message.lessonIds.includes(lesson.lessonId)) message.lessonIds.push(lesson.lessonId);
                    touchedLessons.set(lesson.lessonId, { ...lesson });
                }
            }
            thread.messages.push(message);
            return { review, value: { thread, message, duplicate: false } };
        });
        for (const lesson of touchedLessons.values()) await this.store.appendLesson(lesson);
        this.changed(reviewId, "message");
        return result;
    }

    async setThreadStatus(reviewId: string, threadId: string, status: unknown) {
        if (typeof status !== "string" || !THREAD_STATUSES.includes(status)) throw invalid(`status must be one of ${THREAD_STATUSES.join(", ")}.`);
        const thread = await this.store.updateReview(reviewId, (review) => {
            if (!review) throw notFound(`Review ${reviewId} not found.`);
            if (isRetiredCommitReview(review)) throw retiredCommitError(review);
            const t = findThread(review, threadId);
            t.status = status;
            return { review, value: t };
        });
        this.changed(reviewId, "status");
        return thread;
    }

    // Claim before doing any async prompt work or sending; only one provider may send an attempt.
    async claimDelivery(reviewId: string, threadId: string, messageId: string, { retry = false, senderSessionId }: { retry?: boolean; senderSessionId?: string } = {}) {
        const claim = await this.store.updateReview(reviewId, (review) => {
            if (!review) throw notFound(`Review ${reviewId} not found.`);
            if (isRetiredCommitReview(review)) throw retiredCommitError(review);
            const message = findThread(review, threadId).messages.find((m) => m.messageId === messageId);
            if (!message || message.author !== "user") throw invalid(`Message ${messageId} is not a user message in ${threadId}.`);
            const current = message.delivery;
            const initial = current?.state === "draft" || (current?.state === "saving" && !current.attempts);
            if (!initial && !(retry && ["failed", "no-reply"].includes(current?.state ?? ""))) return { write: false, value: null };
            const attempt = { attemptId: randomUUID(), attempts: (current?.attempts ?? 0) + 1 };
            message.delivery = { state: "saving", ...attempt, senderSessionId, claimPid: this.pid, error: null, updatedAt: nowIso() };
            return { review, value: attempt };
        });
        if (claim) this.changed(reviewId, "delivery");
        return claim;
    }

    // Claims every draft in one atomic update so a submitted review is sent once, as one batch.
    async claimDrafts(reviewId: string, { senderSessionId }: { senderSessionId?: string } = {}) {
        const claims = await this.store.updateReview(reviewId, (review) => {
            if (!review) throw notFound(`Review ${reviewId} not found.`);
            if (isRetiredCommitReview(review)) throw retiredCommitError(review);
            const drafts = allMessages(review).filter((e) => e.message.author === "user" && e.message.delivery?.state === "draft");
            if (!drafts.length) return { write: false, value: [] };
            const batchId = randomUUID();
            const value = drafts.map(({ thread, message }) => {
                const attempt = { attemptId: randomUUID(), attempts: (message.delivery!.attempts ?? 0) + 1 };
                message.delivery = { state: "saving", ...attempt, batchId, senderSessionId, claimPid: this.pid, error: null, updatedAt: nowIso() };
                return { threadId: thread.threadId, messageId: message.messageId, ...attempt };
            });
            return { review, value };
        });
        if (claims.length) this.changed(reviewId, "delivery");
        return claims;
    }

    // Records how an ask-mode review delivers comments; null asks the reviewer again.
    async setDeliveryChoice(reviewId: string, mode: DeliveryChoice) {
        if (mode !== null && !REVIEW_DELIVERY_CHOICES.includes(mode)) {
            throw invalid(`mode must be one of ${REVIEW_DELIVERY_CHOICES.join(", ")}, or null.`);
        }
        const changed = await this.store.updateReview(reviewId, (review) => {
            if (!review) throw notFound(`Review ${reviewId} not found.`);
            if ((review.deliveryMode ?? null) === mode) return { write: false, value: false };
            if (mode) review.deliveryMode = mode;
            else delete review.deliveryMode;
            return { review, value: true };
        });
        if (changed) this.changed(reviewId, "delivery-mode");
        return mode;
    }

    // Removes a draft the agent has never seen; a thread left without messages goes with it.
    async discardDraft(reviewId: string, messageId: string) {
        const result = await this.store.updateReview(reviewId, (review) => {
            if (!review) throw notFound(`Review ${reviewId} not found.`);
            const entry = allMessages(review).find((e) => e.message.messageId === messageId);
            if (!entry) throw notFound(`Message ${messageId} not found.`);
            if (entry.message.author !== "user" || entry.message.delivery?.state !== "draft") {
                throw new ReviewError("conflict", `Message ${messageId} is not a draft; only drafts can be discarded.`);
            }
            const { thread } = entry;
            thread.messages = thread.messages.filter((m) => m !== entry.message);
            const threadRemoved = thread.messages.length === 0;
            if (threadRemoved) review.threads = review.threads.filter((t) => t !== thread);
            return { review, value: { threadId: thread.threadId, threadRemoved } };
        });
        this.changed(reviewId, "message");
        return result;
    }

    // A marker is only a lookup hint, never permission to release a draft or transfer processing ownership.
    async processDelivery(reviewId: string, messageId: string, { attemptId, sessionMessageId, sessionId, finished = false }: { attemptId?: string; sessionMessageId?: string; sessionId?: string; finished?: boolean }) {
        const applied = await this.store.updateReview(reviewId, (review) => {
            const current = review && allMessages(review).find((e) => e.message.messageId === messageId)?.message.delivery;
            // Older queued attempts have no sender field. Only their exact persisted transport event
            // may establish one; a marker by itself (including while saving) cannot do so.
            const legacyQueued = !current?.senderSessionId && current?.state === "queued"
                && sessionMessageId && current.sessionMessageId === sessionMessageId;
            if (!current?.attemptId || !sessionId || (!legacyQueued && current.senderSessionId !== sessionId)
                || !["saving", "queued", "processing"].includes(current.state)
                || (current.processedBy && current.processedBy !== sessionId)
                || (attemptId ? current.attemptId !== attemptId : !sessionMessageId || current.sessionMessageId !== sessionMessageId)
                || (current.sessionMessageId && current.sessionMessageId !== sessionMessageId)) {
                return { write: false, value: false };
            }
            Object.assign(current, { state: finished ? "no-reply" : "processing", senderSessionId: sessionId, processedBy: sessionId, processingAt: nowIso(), updatedAt: nowIso() });
            return { review, value: true };
        });
        if (applied) this.changed(reviewId, "delivery");
        return applied;
    }

    // Applies a delivery transition; later states win within the claimed attempt.
    // Non-state fields (e.g. sessionMessageId) are merged even when the state change is ignored.
    async setDelivery(reviewId: string, messageId: string, patch: Partial<MessageDelivery>, { attemptId }: { attemptId?: string } = {}) {
        const applied = await this.store.updateReview(reviewId, (review) => {
            if (!review) return { write: false, value: false };
            const entry = allMessages(review).find((e) => e.message.messageId === messageId);
            if (!entry || !entry.message.delivery) return { write: false, value: false };
            const current = entry.message.delivery;
            if (attemptId && current.attemptId !== attemptId) return { write: false, value: false };
            const { state, ...rest } = patch;
            if (state === "failed" && !["saving", "failed"].includes(current.state)) return { write: false, value: false };
            const allowState = Boolean(state) && current.state !== "replied"
                && (state === "failed" || DELIVERY_RANK[state!] >= DELIVERY_RANK[current.state]);
            if (!allowState && Object.keys(rest).length === 0) return { write: false, value: false };
            entry.message.delivery = { ...current, ...rest, ...(allowState ? { state: state! } : {}), updatedAt: nowIso() };
            return { review, value: true };
        });
        if (applied) this.changed(reviewId, "delivery");
        return applied;
    }

    // Marks user messages still "processing" as unanswered (called when the agent goes idle).
    // With a sessionId, only messages that session was processing are settled; another session's turn may still be running.
    async settleProcessing(reviewId: string, { sessionId }: { sessionId?: string } = {}) {
        const ids = await this.store.updateReview(reviewId, (review) => {
            if (!review) return { write: false, value: [] };
            const hits = allMessages(review).filter(({ message }) => message.delivery?.state === "processing"
                && (!sessionId || !message.delivery.processedBy || message.delivery.processedBy === sessionId));
            for (const { message } of hits) message.delivery = { ...message.delivery, state: "no-reply", updatedAt: nowIso() };
            return hits.length ? { review, value: hits.map((h) => h.message.messageId) } : { write: false, value: [] };
        });
        if (ids.length) this.changed(reviewId, "delivery");
        return ids;
    }

    // A comment claimed by a provider process that has since stopped can never be sent, so it is failed
    // and the reviewer can resend it. Claims held by running providers, including other sessions', are left alone.
    async recoverAbandonedClaims(reviewId: string) {
        const ids = await this.store.updateReview(reviewId, (review) => {
            if (!review) return { write: false, value: [] };
            const hits = allMessages(review).filter(({ message }) => {
                const d = message.delivery;
                return d?.state === "saving" && Number.isInteger(d.claimPid) && d.claimPid !== this.pid && !this.isProcessAlive(d.claimPid!);
            });
            for (const { message } of hits) {
                message.delivery = { ...message.delivery, state: "failed", error: "The extension stopped before this comment was sent. Resend it.", updatedAt: nowIso() };
            }
            return hits.length ? { review, value: hits.map((h) => h.message.messageId) } : { write: false, value: [] };
        });
        if (ids.length) this.changed(reviewId, "delivery");
        return ids;
    }

    async findMessage(reviewId: string, messageId: string) {
        const review = await this.getReview(reviewId);
        const entry = allMessages(review).find((e) => e.message.messageId === messageId);
        if (!entry) throw notFound(`Message ${messageId} not found.`);
        return { review, thread: entry.thread, message: entry.message };
    }

    async revisionLines(reviewId: string, revisionId: string, filePath: string) {
        const review = await this.getReview(reviewId);
        this.git.safeJoin(review.repoRoot, filePath);
        const snapshot = await this.getSnapshot(reviewId, revisionId);
        const file = snapshot.files.find((entry) => entry.path === filePath);
        if (!file || file.binary || file.status === "deleted") {
            throw new ReviewError("conflict", `Cannot recover ${filePath} from revision ${revisionId}. Check the selection before retrying.`);
        }
        // Anchors must use immutable revision content, not the now-edited working file.
        const base = file.status === "added" ? [] : await this.git.readCommitFile(review.repoRoot, snapshot.baseCommit, file.oldPath ?? filePath);
        if (base?.[base.length - 1] === "") base.pop();
        const lines = base && base.length <= MAX_FULL_FILE_LINES ? revisionContent(file, base) : null;
        if (!lines || lines.length > MAX_FULL_FILE_LINES) {
            throw new ReviewError("conflict", `Cannot recover full-file content for ${filePath} from revision ${revisionId}. Check the selection before retrying.`);
        }
        return lines;
    }

    // Everything the agent prompt needs for one message, resolved against the current revision.
    async promptContext(reviewId: string, threadId: string) {
        const review = await this.getReview(reviewId);
        const thread = findThread(review, threadId);
        let excerpt: { text: string; header?: string } | null = null;
        let selected: string[] | null = null;
        const loc = thread.location;
        if (loc && (thread.kind === "line" || thread.kind === "change") && loc.state !== "outdated") {
            const snapshot = await this.store.readSnapshot(reviewId, loc.revisionId);
            const file = snapshot?.files.find((f) => f.path === loc.path);
            if (file) {
                excerpt = hunkExcerpt(file, loc.side!, loc.startLine!, loc.endLine!);
                selected = selectedLines(file, loc.side!, loc.startLine!, loc.endLine!);
            }
            if (!selected || selected.length !== loc.endLine! - loc.startLine! + 1) {
                const content = loc.side === "old"
                    ? await this.git.readCommitFile(review.repoRoot, snapshot?.baseCommit!, thread.anchor!.oldPath ?? loc.path)
                    : await this.revisionLines(reviewId, loc.revisionId, loc.path);
                selected = content ? content.slice(loc.startLine! - 1, loc.endLine) : selected;
            }
        }
        if (loc && thread.kind === "file") {
            const snapshot = await this.store.readSnapshot(reviewId, loc.revisionId);
            const file = snapshot?.files.find((f) => f.path === loc.path);
            if (file && file.oldMode !== file.newMode && (file.oldMode || file.newMode)) {
                excerpt = { text: `File mode: ${file.oldMode ?? "(absent)"} to ${file.newMode ?? "(absent)"}` };
            }
        }
        return {
            review: {
                ...review,
                headCommit: review.git?.headCommit,
                baseCommit: review.git?.baseCommit,
            },
            thread,
            excerpt,
            selected,
        };
    }

    // The agent's view of a review. Drafts are still held by the reviewer, so only their count is shown.
    summarize(review: Review, { threadId, includeResolved = false, maxBody = 2000 }: { threadId?: string; includeResolved?: boolean; maxBody?: number } = {}) {
        if (isRetiredCommitReview(review)) throw retiredCommitError(review);
        const isDraft = (m: ReviewMessage) => m.author === "user" && m.delivery?.state === "draft";
        const visible = review.threads.filter((t) => t.messages.some((m) => !isDraft(m)));
        const threads = visible.filter((t) => (threadId ? t.threadId === threadId : includeResolved || t.status === "active"));
        return {
            reviewId: review.reviewId,
            title: review.title,
            description: review.description ?? null,
            repoRoot: review.repoRoot,
            branch: review.branch,
            base: review.base,
            scope: scopeOf(review),
            currentRevisionId: review.currentRevisionId,
            git: review.git,
            counts: {
                total: visible.length,
                active: visible.filter((t) => t.status === "active").length,
                awaitingAgent: allMessages(review).filter((e) => ["queued", "processing", "failed", "no-reply"].includes(e.message.delivery?.state ?? "")).length,
                drafts: allMessages(review).filter((e) => isDraft(e.message)).length,
            },
            threads: threads.map((t) => ({
                threadId: t.threadId,
                kind: t.kind,
                agentReview: t.agentReview,
                status: t.status,
                location: t.location,
                originalLocation: t.anchor ? { revisionId: t.anchor.revisionId, path: t.anchor.path, side: t.anchor.side, startLine: t.anchor.startLine, endLine: t.anchor.endLine } : null,
                messages: t.messages.filter((m) => !isDraft(m)).map((m) => ({
                    messageId: m.messageId,
                    author: m.author,
                    createdAt: m.createdAt,
                    body: m.body.length > maxBody ? `${m.body.slice(0, maxBody)}...` : m.body,
                    delivery: m.delivery?.state,
                    outcome: m.outcome,
                })),
            })),
            lessons: review.lessons.map((l) => ({ ...l, status: l.status ?? "saved" })),
        };
    }
}
