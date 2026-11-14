// Self review canvas client: renders the diff, inline threads, and composers; talks to the
// per-instance loopback server with the token from the URL.
import { createSettingsApi } from "./settings-api.mjs";

type Scope = "all" | "pending";
type DiffSide = "old" | "new";
type ThreadKind = "overview" | "file" | "change" | "line";
type ThreadStatus = "active" | "resolved" | "wontfix" | "closed";
type View =
    | { type: "overview" | "lessons" | "agent-comments" }
    | { type: "file" | "folder"; path: string };
type Language = "code" | "xml" | "json" | "yaml" | "markdown";
type LexicalState = {
    comment?: string | null;
    tag?: boolean;
    fence?: { marker: string; language: Language | null; lexical: LexicalState } | null;
};
type DiffRow = {
    t: "add" | "del" | "ctx";
    o?: number | null;
    n?: number | null;
    s: string;
    noNewlineAtEnd?: boolean;
};
type DiffHunk = {
    oldStart?: number;
    oldLines?: number;
    newStart?: number;
    newLines?: number;
    header?: string;
    rows: DiffRow[];
    gap?: boolean;
};
type DiffFile = {
    path: string;
    oldPath?: string | null;
    status: "modified" | "added" | "deleted" | "renamed";
    additions: number;
    deletions: number;
    binary: boolean;
    note?: string | null;
    untracked?: boolean;
    oldMode?: string | null;
    newMode?: string | null;
    typeChanged?: boolean;
    hunks: DiffHunk[];
    full?: boolean;
};
type Snapshot = { revisionId: string; files: DiffFile[] };
type ThreadLocation = {
    path: string;
    side?: DiffSide;
    startLine?: number;
    endLine?: number;
    state?: string;
};
type ThreadAnchor = ThreadLocation & {
    revisionId: string;
    selectedLines?: string[];
};
type MessageDelivery = {
    state: "draft" | "saving" | "queued" | "processing" | "replied" | "no-reply" | "failed";
    queuedAt?: string | null;
    error?: string | null;
};
type ReviewMessage = {
    messageId: string;
    author: "user" | "agent";
    body: string;
    createdAt: string;
    delivery?: MessageDelivery | null;
    outcome?: string | null;
    verification?: string | null;
    lessonIds?: string[];
    clientRequestId?: string;
};
type FindingEvidence = { source?: string; baseline?: string; validation?: string };
type FindingReport = {
    model: string;
    category: string;
    assessment: string;
    severity: string;
    evidence?: FindingEvidence;
    revisionId: string;
    approvalMessageId?: string | null;
    runId: string;
};
type ReviewThread = {
    threadId: string;
    kind: ThreadKind;
    status: ThreadStatus;
    location?: ThreadLocation | null;
    anchor?: ThreadAnchor | null;
    messages: ReviewMessage[];
    agentReview?: FindingReport | null;
};
type Lesson = {
    lessonId: string;
    scope: string;
    status?: string;
    rule: string;
    savedTo?: string | null;
    threadId: string;
    createdAt: string;
};
type Revision = {
    revisionId: string;
    createdAt: string;
    files: number;
    additions: number;
    deletions: number;
};
type GitStatus = {
    headCommit?: string | null;
    baseCommit?: string | null;
    upstream?: { ahead: number | null; behind: number | null; name: string } | null;
    branch?: string | null;
    uncommittedFiles?: number;
};
type AgentReviewResult = {
    model: string;
    threadIds: string[];
    error?: string | null;
    summary?: string | null;
    ponytail?: {
        status: string;
        summary: string;
        benefits: Array<{
            proposal: string;
            benefit: string;
            evidence: { source: string; baseline: string; validation: string };
        }>;
    } | null;
};
type AgentReviewRun = {
    runId: string;
    state: string;
    focus: string;
    revisionId: string;
    models: string[];
    results: AgentReviewResult[];
    intent?: string | null;
    skills?: Array<{ name: string; release?: string | null }>;
    error?: string | null;
};
type Review = {
    reviewId: string;
    title: string;
    repoRoot: string;
    base: string | null;
    branch?: string | null;
    scope?: Scope;
    currentRevisionId: string | null;
    revisions: Revision[];
    threads: ReviewThread[];
    lessons: Lesson[];
    git?: GitStatus | null;
    description?: { version: number; revisionId: string | null; body: string } | null;
    deliveryMode?: "immediate" | "batch" | null;
    agentReviews?: AgentReviewRun[];
};
type PullRequest = { number: number; url: string };
type SkillCatalog = {
    selected: string[];
    skills: Array<{
        name: string;
        title: string;
        role: string;
        summary: string;
        upstream: { repository: string; release: string; path: string; fileCommit: string };
        license: { spdx: string };
        attribution?: string | null;
    }>;
};
type StateResponse = {
    review: Review;
    session?: { busy: boolean | null };
    pullRequest: PullRequest | null;
    agentReviewAvailable: boolean;
    reviewSkillsAvailable: boolean;
    agentReviewSuggestedModels: string[];
    settingsPayload: unknown;
};
type RawStateResponse = Omit<StateResponse, "agentReviewAvailable" | "reviewSkillsAvailable" | "agentReviewSuggestedModels" | "settingsPayload"> & {
    agentReviewAvailable?: boolean;
    reviewSkillsAvailable?: boolean;
    agentReviewSuggestedModels?: string[];
};
type ContentEntry =
    | { status: "loading" }
    | { status: "ready"; full: DiffFile }
    | { status: "unavailable"; reason?: string };
type PendingComment = { clientRequestId: string; sending?: boolean; error?: string | null };
type Selection = { path: string; hunk: number; anchor: number; from: number; to: number; full: boolean };
type RowPosition = { path: string; h: number; i: number; full: boolean };
type ConfigureDialog = { type: "configure"; learning: LearningMode; delivery: DeliveryMode; saving: boolean; error: string };
type AgentReviewDialog = {
    type: "agent-review";
    reviewId: string;
    revisionId: string | null;
    scope: string;
    models: string;
    focus: "review" | "simplify" | "both";
    intent: string;
    saving: boolean;
    skillNames?: string[];
    skillCatalog: SkillCatalog | null;
    skillsLoading: boolean;
    skillsError: string;
    saveSkillDefaults: boolean;
    tab: "general" | "skills";
    saveDefaults: boolean;
    skipDialog: boolean;
    opener: string;
    settingsOnly: boolean;
    error: string;
};
type Dialog = ConfigureDialog | AgentReviewDialog;
type FileTreeNode = { name: string; path: string; dirs: Map<string, FileTreeNode>; files: DiffFile[]; children: FileTreeNode[] };
type State = {
    review: Review | null;
    snapshot: Snapshot | null;
    pullRequest: PullRequest | null;
    busy: boolean | null;
    connection: "connecting" | "open" | "lost";
    view: View;
    selection: Selection | null;
    dragging: boolean;
    pendingJump: string | null;
    open: Set<string>;
    pending: Map<string, PendingComment>;
    expanded: Set<string>;
    collapsedThreads: Set<string>;
    showResolved: boolean;
    collapsedDirs: Set<string> | null;
    fileFold: Map<string, boolean>;
    content: Map<string, ContentEntry>;
    settings: import("../../types/contracts.js").RepoSettings | null;
    dialog: Dialog | null;
    switching: boolean;
    submitting: boolean;
    agentReviewAvailable: boolean;
    agentReviewSettings: import("../../types/contracts.js").AgentReviewDefaults | null;
    agentReviewSettingsAvailable: boolean;
    agentReviewSettingsError: string;
    agentReviewSuggestedModels: string[];
    startingReview: boolean;
    reviewSkillsAvailable: boolean;
    skillOverrides: Map<string, string[]>;
    approving: Set<string>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isView(value: unknown): value is View {
    if (!isRecord(value)) return false;
    if (value.type === "overview" || value.type === "lessons" || value.type === "agent-comments") return true;
    return (value.type === "file" || value.type === "folder") && typeof value.path === "string";
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isOptionalString(value: unknown): boolean {
    return value === undefined || value === null || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isDiffRow(value: unknown): value is DiffRow {
    return isRecord(value)
        && (value.t === "add" || value.t === "del" || value.t === "ctx")
        && (value.o === undefined || value.o === null || typeof value.o === "number")
        && (value.n === undefined || value.n === null || typeof value.n === "number")
        && typeof value.s === "string"
        && (value.noNewlineAtEnd === undefined || typeof value.noNewlineAtEnd === "boolean");
}

function isDiffHunk(value: unknown): value is DiffHunk {
    return isRecord(value)
        && typeof value.oldStart === "number" && typeof value.oldLines === "number"
        && typeof value.newStart === "number" && typeof value.newLines === "number"
        && typeof value.header === "string"
        && Array.isArray(value.rows) && value.rows.every(isDiffRow)
        && (value.gap === undefined || typeof value.gap === "boolean");
}

function isDiffFile(value: unknown): value is DiffFile {
    return isRecord(value)
        && typeof value.path === "string"
        && isOptionalString(value.oldPath)
        && (value.status === "modified" || value.status === "added" || value.status === "deleted" || value.status === "renamed")
        && typeof value.additions === "number" && typeof value.deletions === "number"
        && typeof value.binary === "boolean" && isOptionalString(value.note)
        && (value.untracked === undefined || typeof value.untracked === "boolean")
        && isOptionalString(value.oldMode) && isOptionalString(value.newMode)
        && (value.typeChanged === undefined || typeof value.typeChanged === "boolean")
        && Array.isArray(value.hunks) && value.hunks.every(isDiffHunk)
        && (value.full === undefined || typeof value.full === "boolean");
}

function isRevision(value: unknown): value is Revision {
    return isRecord(value)
        && typeof value.revisionId === "string" && typeof value.createdAt === "string"
        && typeof value.files === "number" && typeof value.additions === "number"
        && typeof value.deletions === "number";
}

function isLocation(value: unknown): value is ThreadLocation {
    return isRecord(value) && typeof value.path === "string"
        && (value.side === undefined || value.side === "old" || value.side === "new")
        && (value.startLine === undefined || typeof value.startLine === "number")
        && (value.endLine === undefined || typeof value.endLine === "number")
        && (value.state === undefined || typeof value.state === "string");
}

function isAnchor(value: unknown): value is ThreadAnchor {
    return isRecord(value) && typeof value.revisionId === "string"
        && (value.selectedLines === undefined || isStringArray(value.selectedLines))
        && isLocation(value);
}

function isMessage(value: unknown): value is ReviewMessage {
    if (!isRecord(value) || typeof value.messageId !== "string"
        || (value.author !== "user" && value.author !== "agent")
        || typeof value.body !== "string" || typeof value.createdAt !== "string"
        || !isOptionalString(value.outcome) || !isOptionalString(value.verification)
        || (value.lessonIds !== undefined && (!Array.isArray(value.lessonIds) || !value.lessonIds.every((id) => typeof id === "string")))) {
        return false;
    }
    if (value.delivery == null) return true;
    return isRecord(value.delivery)
        && ["draft", "saving", "queued", "processing", "replied", "no-reply", "failed"].includes(String(value.delivery.state))
        && isOptionalString(value.delivery.queuedAt) && isOptionalString(value.delivery.error);
}

function isFinding(value: unknown): value is FindingReport {
    if (!isRecord(value) || typeof value.model !== "string" || typeof value.category !== "string"
        || typeof value.assessment !== "string" || typeof value.severity !== "string"
        || typeof value.revisionId !== "string" || typeof value.runId !== "string"
        || !isOptionalString(value.approvalMessageId)) return false;
    if (value.evidence === undefined || value.evidence === null) return true;
    return isRecord(value.evidence) && isOptionalString(value.evidence.source)
        && isOptionalString(value.evidence.baseline) && isOptionalString(value.evidence.validation);
}

function isThread(value: unknown): value is ReviewThread {
    if (!isRecord(value) || typeof value.threadId !== "string"
        || !["overview", "file", "change", "line"].includes(String(value.kind))
        || !["active", "resolved", "wontfix", "closed"].includes(String(value.status))
        || !Array.isArray(value.messages) || !value.messages.every(isMessage)
        || (value.location !== undefined && value.location !== null && !isLocation(value.location))) return false;
    if (value.anchor !== undefined && value.anchor !== null) {
        if (!isAnchor(value.anchor)) return false;
    }
    return value.agentReview === undefined || value.agentReview === null || isFinding(value.agentReview);
}

function isLesson(value: unknown): value is Lesson {
    return isRecord(value)
        && typeof value.lessonId === "string" && typeof value.scope === "string"
        && (value.status === undefined || typeof value.status === "string")
        && typeof value.rule === "string" && isOptionalString(value.savedTo)
        && typeof value.threadId === "string" && typeof value.createdAt === "string";
}

function isAgentReviewRun(value: unknown): value is AgentReviewRun {
    if (!isRecord(value) || typeof value.runId !== "string" || typeof value.state !== "string"
        || typeof value.focus !== "string" || typeof value.revisionId !== "string"
        || !Array.isArray(value.models) || !value.models.every((model) => typeof model === "string")
        || !Array.isArray(value.results) || !isOptionalString(value.intent) || !isOptionalString(value.error)) return false;
    if (value.skills !== undefined && (!Array.isArray(value.skills) || !value.skills.every((skill) =>
        isRecord(skill) && typeof skill.name === "string" && isOptionalString(skill.release)))) return false;
    return value.results.every((result) => {
        if (!isRecord(result) || typeof result.model !== "string" || !Array.isArray(result.threadIds)
            || !result.threadIds.every((id) => typeof id === "string")
            || !isOptionalString(result.error) || !isOptionalString(result.summary)) return false;
        if (result.ponytail === undefined || result.ponytail === null) return true;
        return isRecord(result.ponytail) && typeof result.ponytail.status === "string"
            && typeof result.ponytail.summary === "string" && Array.isArray(result.ponytail.benefits)
            && result.ponytail.benefits.every((benefit) => isRecord(benefit)
                && typeof benefit.proposal === "string" && typeof benefit.benefit === "string"
                && isRecord(benefit.evidence) && typeof benefit.evidence.source === "string"
                && typeof benefit.evidence.baseline === "string" && typeof benefit.evidence.validation === "string");
    });
}

function isGitStatus(value: unknown): value is GitStatus {
    if (!isRecord(value) || !isOptionalString(value.headCommit) || !isOptionalString(value.baseCommit)
        || !isOptionalString(value.branch) || (value.uncommittedFiles !== undefined && typeof value.uncommittedFiles !== "number")) return false;
    return value.upstream === undefined || value.upstream === null
        || (isRecord(value.upstream) && (value.upstream.ahead === null || typeof value.upstream.ahead === "number")
            && (value.upstream.behind === null || typeof value.upstream.behind === "number")
            && typeof value.upstream.name === "string");
}

function isDescription(value: unknown): value is NonNullable<Review["description"]> {
    return isRecord(value) && typeof value.version === "number"
        && (value.revisionId === null || typeof value.revisionId === "string") && typeof value.body === "string";
}

function isReview(value: unknown): value is Review {
    return isRecord(value)
        && typeof value.reviewId === "string"
        && typeof value.title === "string"
        && typeof value.repoRoot === "string"
        && (value.base === null || typeof value.base === "string")
        && (value.branch === undefined || value.branch === null || typeof value.branch === "string")
        && (value.scope === undefined || value.scope === "all" || value.scope === "pending")
        && (value.currentRevisionId === null || typeof value.currentRevisionId === "string")
        && Array.isArray(value.revisions) && value.revisions.every(isRevision)
        && Array.isArray(value.threads) && value.threads.every(isThread)
        && Array.isArray(value.lessons) && value.lessons.every(isLesson)
        && (value.git === undefined || value.git === null || isGitStatus(value.git))
        && (value.description === undefined || value.description === null || isDescription(value.description))
        && (value.deliveryMode === undefined || value.deliveryMode === null
            || value.deliveryMode === "immediate" || value.deliveryMode === "batch")
        && (value.agentReviews === undefined || (Array.isArray(value.agentReviews) && value.agentReviews.every(isAgentReviewRun)));
}

function parseReview(value: unknown): Review {
    if (!isReview(value)) throw new Error("Invalid review state response.");
    return value;
}

function isReviewFocus(value: string | undefined): value is "review" | "simplify" | "both" {
    return value === "review" || value === "simplify" || value === "both";
}

function isThreadStatus(value: string): value is ThreadStatus {
    return value === "active" || value === "resolved" || value === "wontfix" || value === "closed";
}

function isLearningMode(value: string): value is LearningMode {
    return value === "off" || value === "suggest" || value === "auto";
}

function isSnapshot(value: unknown): value is Snapshot {
    return isRecord(value) && typeof value.revisionId === "string"
        && Array.isArray(value.files) && value.files.every(isDiffFile);
}

function parseSnapshot(value: unknown): Snapshot {
    if (!isSnapshot(value)) throw new Error("Invalid snapshot response.");
    return value;
}

function parseContent(value: unknown, file: DiffFile): ContentEntry {
    if (!isRecord(value) || typeof value.available !== "boolean") throw new Error("Invalid content response.");
    if (!value.available) return { status: "unavailable", reason: typeof value.reason === "string" ? value.reason : undefined };
    if (!isStringArray(value.lines)) {
        throw new Error("Invalid full-file content response.");
    }

    return { status: "ready", full: buildFullFile(file, value.lines) };
}

function isStateResponse(value: unknown): value is RawStateResponse {
    if (!isRecord(value) || !isReview(value.review)
        || (value.session !== undefined && (!isRecord(value.session)
            || (value.session.busy !== null && typeof value.session.busy !== "boolean")))
        || (value.pullRequest !== undefined && value.pullRequest !== null
            && (!isRecord(value.pullRequest) || typeof value.pullRequest.number !== "number" || typeof value.pullRequest.url !== "string"))
        || (value.agentReviewAvailable !== undefined && typeof value.agentReviewAvailable !== "boolean")
        || (value.reviewSkillsAvailable !== undefined && typeof value.reviewSkillsAvailable !== "boolean")
        || (value.agentReviewSuggestedModels !== undefined && !isStringArray(value.agentReviewSuggestedModels))) return false;
    return true;
}

function parseState(value: unknown): StateResponse {
    if (!isStateResponse(value)) throw new Error("Invalid state response.");
    return {
        review: value.review,
        session: value.session === undefined ? undefined : { busy: value.session.busy },
        pullRequest: value.pullRequest == null ? null : { number: value.pullRequest.number, url: value.pullRequest.url },
        agentReviewAvailable: value.agentReviewAvailable === true,
        reviewSkillsAvailable: value.reviewSkillsAvailable === true,
        agentReviewSuggestedModels: value.agentReviewSuggestedModels ?? [],
        settingsPayload: value,
    };
}

function isSkill(value: unknown): value is SkillCatalog["skills"][number] {
    return isRecord(value)
        && typeof value.name === "string" && typeof value.title === "string"
        && typeof value.role === "string" && typeof value.summary === "string"
        && isRecord(value.upstream) && typeof value.upstream.repository === "string"
        && typeof value.upstream.release === "string" && typeof value.upstream.path === "string"
        && typeof value.upstream.fileCommit === "string"
        && isRecord(value.license) && typeof value.license.spdx === "string"
        && isOptionalString(value.attribution);
}

function isSkillCatalog(value: unknown): value is SkillCatalog {
    return isRecord(value)
        && Array.isArray(value.selected) && value.selected.every((name) => typeof name === "string")
        && Array.isArray(value.skills) && value.skills.every(isSkill);
}

function parseSkillCatalog(value: unknown): SkillCatalog {
    if (!isSkillCatalog(value)) throw new Error("Invalid review skills response.");
    return value;
}

const TOKEN = new URLSearchParams(location.search).get("t") ?? "";
const STATUSES: ThreadStatus[] = ["active", "resolved", "wontfix", "closed"];
const STALE_QUEUE_MS = 120000;
const FINDING_ASSESSMENTS: Record<string, string> = { confirmed: "Confirmed", "pre-existing": "Pre-existing", rejected: "Rejected", unverified: "Unverified" };
const FINDING_SEVERITIES: Record<string, string> = { critical: "Critical", required: "Required", optional: "Optional", nit: "Nit", fyi: "FYI" };

const state: State = {
    review: null,
    snapshot: null,
    pullRequest: null,
    busy: null,
    connection: "connecting",
    view: { type: "overview" },
    selection: null,
    dragging: false,
    pendingJump: null,
    open: new Set<string>(),
    pending: new Map<string, PendingComment>(),
    expanded: new Set<string>(),
    collapsedThreads: new Set<string>(),
    showResolved: false,
    collapsedDirs: null,
    fileFold: new Map<string, boolean>(),
    content: new Map<string, ContentEntry>(),
    settings: null,
    dialog: null,
    switching: false,
    submitting: false,
    agentReviewAvailable: false,
    agentReviewSettings: null,
    agentReviewSettingsAvailable: false,
    agentReviewSettingsError: "",
    agentReviewSuggestedModels: [],
    startingReview: false,
    reviewSkillsAvailable: false,
    skillOverrides: new Map(),
    approving: new Set(),
};

const FOLDER_VIEW_ROW_BUDGET = 3000;
const settingsApi = createSettingsApi((method, path, body) => api(method, path, body));

const LEARNING_MODES = ["off", "suggest", "auto"] as const;
type LearningMode = (typeof LEARNING_MODES)[number];
const LEARNING: Record<LearningMode, { label: string; pill: string; hint: string }> = {
    off: { label: "Off", pill: "Off", hint: "Copilot only addresses each comment. It does not edit instruction files or record guidelines unless you ask." },
    suggest: { label: "Suggest", pill: "Suggest", hint: "Copilot proposes a guideline in the thread when your feedback reveals a reusable rule, and saves it only after you approve." },
    auto: { label: "Save automatically", pill: "Auto-save", hint: "Copilot saves settled guidelines to the repository's instruction files and tells you where. Personal rules still wait for your confirmation." },
};
const DELIVERY_MODES = ["immediate", "batch", "ask"] as const;
type DeliveryMode = (typeof DELIVERY_MODES)[number];
const DELIVERY: Record<DeliveryMode, { label: string; pill: string; hint: string }> = {
    immediate: { label: "Send each comment now", pill: "Immediate", hint: "Each comment goes to Copilot as soon as you post it." },
    batch: { label: "Batch into a review", pill: "Batch", hint: "Comments wait as drafts until you submit the review, then Copilot addresses them together in one pass." },
    ask: { label: "Ask for each review", pill: "Ask", hint: "The first time you comment on a review, choose whether to send each comment now or batch them." },
};
const LESSON_STATUSES: Record<"proposed" | "saved" | "declined", string> = {
    proposed: "Proposed by Copilot and not saved yet. Approve it in the thread to save it.",
    saved: "Saved as a guideline for future work.",
    declined: "Declined; not saved.",
};
const scopeOf = (review: Review | null) => (review?.scope === "pending" ? "pending" : "all");
const scopeLabel = (scope: Scope) => (scope === "pending" ? "pending changes" : "all changes");
const learningMode = (): LearningMode => {
    const mode = state.settings?.learning;
    return mode === "suggest" || mode === "auto" ? mode : "off";
};
const deliveryRepoMode = (): DeliveryMode => {
    const mode = state.settings?.delivery;
    return mode === "batch" || mode === "ask" ? mode : "immediate";
};
// Mirrors the server's resolveDelivery: null while an ask-mode review is undecided. Without settings nothing is held.
function deliveryMode() {
    if (!state.settings) return "immediate";
    const mode = deliveryRepoMode();
    if (mode !== "ask") return mode;
    const chosen = state.review?.deliveryMode;
    return chosen === "immediate" || chosen === "batch" ? chosen : null;
}
const draftMessages = () => (state.review?.threads ?? []).flatMap((t) => t.messages).filter((m) => m.author === "user" && m.delivery?.state === "draft");
// Lessons recorded before statuses existed were saved by definition.
const lessonStatus = (lesson: Lesson): "proposed" | "saved" | "declined" => (lesson.status === "proposed" || lesson.status === "declined" || lesson.status === "saved" ? lesson.status : "saved");
const lessonBadge = (lesson: Lesson) => {
    const status = lessonStatus(lesson);
    return `<span class="badge lesson-${status}" title="${esc(LESSON_STATUSES[status])}">${status}</span>`;
};

const $ = (sel: string, root: Document | Element = document): HTMLElement | null => root.querySelector<HTMLElement>(sel);
const requiredElement = (sel: string): HTMLElement => {
    const element = $(sel);
    if (!element) throw new Error(`Missing renderer element: ${sel}`);
    return element;
};

function esc(value: unknown): string {
    const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return String(value ?? "").replace(/[&<>"']/g, (character) => entities[character] ?? character);
}

const CODE_KEYWORDS = new Set(("abstract as async await base bool boolean break byte case catch char checked class const continue decimal default delegate delete do double else enum event export extends extern false finally fixed float for foreach from function get if implements import in init int interface internal is let lock long namespace new null object operator out override params partial private protected public readonly record ref required return sbyte sealed set short sizeof stackalloc static string struct super switch this throw true try typeof uint ulong unchecked undefined unsafe ushort using var virtual void volatile while with yield").split(" "));
const highlightedFiles = new WeakMap<DiffFile, string[][]>();

function syntaxLanguage(filePath: string): Language | null {
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    if (["cs", "js", "mjs", "cjs", "jsx", "ts", "tsx", "java", "c", "h", "cpp", "hpp"].includes(ext)) return "code";
    if (["xml", "html", "htm", "csproj", "props", "targets", "config", "svg", "xaml"].includes(ext)) return "xml";
    if (["json", "jsonc"].includes(ext)) return "json";
    if (["yaml", "yml"].includes(ext)) return "yaml";
    if (["md", "markdown", "mdx"].includes(ext)) return "markdown";
    return null;
}

// Lexical highlighting only: escape every source fragment and preserve its exact text.
function highlightLine(text: string, language: Language | null, lexical: LexicalState = {}): string {
    if (!language) return esc(text);
    if (language === "markdown") return highlightMarkdown(text, lexical);
    const out: string[] = [];
    const emit = (value: string, kind?: string | null) => out.push(kind ? `<span class="syn-${kind}">${esc(value)}</span>` : esc(value));
    const tokens = language === "xml"
        ? /<!--|<\/?[\w:.-]+|\/?>|[\w:.-]+(?=\s*=)|"(?:[^"]*)"|'(?:[^']*)'/g
        : /\/\*|\/\/.*$|#[^\n]*$|@"(?:""|[^"])*"|\$?"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|[A-Za-z_$][\w$]*/g;
    let offset = 0;
    while (offset < text.length) {
        if (lexical.comment) {
            const end = text.indexOf(lexical.comment, offset);
            const next = end < 0 ? text.length : end + lexical.comment.length;
            emit(text.slice(offset, next), "comment");
            offset = next;
            if (end < 0) break;
            lexical.comment = null;
            continue;
        }
        tokens.lastIndex = offset;
        const match = tokens.exec(text);
        if (!match) {
            emit(text.slice(offset));
            break;
        }
        emit(text.slice(offset, match.index));
        const token = match[0];
        offset = tokens.lastIndex;
        if ((language === "xml" && token === "<!--") || (language === "code" && token === "/*")) {
            lexical.comment = language === "xml" ? "-->" : "*/";
            emit(token, "comment");
        } else if (language === "xml") {
            if (token.startsWith("<")) lexical.tag = true;
            const kind = token.startsWith("<") || /^\/?>$/.test(token) ? "keyword"
                : /^["']/.test(token) ? "string" : lexical.tag ? "property" : null;
            emit(token, kind);
            if (/\/?>$/.test(token)) lexical.tag = false;
        } else if ((language === "code" || language === "json") && token.startsWith("//")
            || language === "yaml" && token.startsWith("#")) {
            emit(token, "comment");
        } else if (/^(?:@|\$)?["'`]/.test(token)) {
            emit(token, language === "json" && /^\s*:/.test(text.slice(offset)) ? "property" : "string");
        } else if (/^\d/.test(token)) {
            emit(token, "number");
        } else {
            const kind = language === "code" && CODE_KEYWORDS.has(token)
                || language !== "code" && /^(true|false|null)$/.test(token) ? "keyword"
                : language === "yaml" && /^\s*:/.test(text.slice(offset)) ? "property"
                : language === "code" && /^[A-Z]/.test(token) ? "type" : null;
            emit(token, kind);
        }
    }
    return out.join("");
}

const MD_FENCE_ALIASES: Record<string, string> = { javascript: "js", typescript: "ts", csharp: "cs", "c#": "cs", "c++": "cpp", markdown: "md" };
const MD_INLINE = /\\[!-\/:-@[-`{-~]|`+|<!--|!?\[|<(?:https?:\/\/|mailto:)[^<>\s]+>|(?<![\w/])https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]]|<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?\/?>|\*\*|__|~~|[*_|]/g;
const MD_LINK = /!?\[((?:\\.|[^\\\]\n])*)\](?:\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)((?:\s+(?:"[^"]*"|'[^']*'))?\s*)\)|\[([^\]\n]*)\])/y;
const MD_STYLES: Record<string, string> = { "**": "strong", __: "strong", "*": "em", _: "em", "~~": "del" };
const mdToken = (value: string | undefined, cls: string): string => (value ? `<span class="${cls}">${esc(value)}</span>` : "");
const mdBlock = (html: string): string => `<span class="md-block">${html}</span>`;

function fenceLanguage(info: string): Language | null {
    const name = info.trim().split(/[\s{,]/)[0]?.toLowerCase() ?? "";
    return name ? syntaxLanguage(`fence.${MD_FENCE_ALIASES[name] ?? name}`) : null;
}

// Markdown stays source text: markers are dimmed, never removed, so selections and anchors match the file.
function highlightMarkdown(text: string, lexical: LexicalState): string {
    const fence = lexical.fence;
    if (fence) {
        const close = text.match(/^(\s*)(`{3,}|~{3,})(\s*)$/);
        if (close && close[2][0] === fence.marker[0] && close[2].length >= fence.marker.length) {
            lexical.fence = null;
            return mdBlock(esc(close[1]) + mdToken(close[2], "md-mark") + esc(close[3]));
        }
        return mdBlock(fence.language ? highlightLine(text, fence.language, fence.lexical) : esc(text));
    }
    if (lexical.comment) {
        const end = text.indexOf("-->");
        if (end < 0) return mdToken(text, "syn-comment");
        lexical.comment = null;
        return mdToken(text.slice(0, end + 3), "syn-comment") + mdInline(text.slice(end + 3), lexical);
    }
    const open = text.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    if (open && !(open[2][0] === "`" && open[3].includes("`"))) {
        lexical.fence = { marker: open[2], language: fenceLanguage(open[3]), lexical: {} };
        return mdBlock(esc(open[1]) + mdToken(open[2], "md-mark") + mdToken(open[3], "md-lang"));
    }
    if (/^ {0,3}(?:([-*_])(?:[ \t]*\1){2,}|=+)[ \t]*$/.test(text)) return mdToken(text, "md-mark");
    const heading = text.match(/^( {0,3})(#{1,6})((?:\s.*?)?)((?:\s#+)?\s*)$/);
    if (heading) {
        return esc(heading[1]) + mdToken(heading[2], "md-mark")
            + `<span class="md-heading">${mdInline(heading[3], lexical)}</span>` + mdToken(heading[4], "md-mark");
    }
    const definition = text.match(/^( {0,3})(\[(?!\^)[^\]\n]+\]:)(\s*)(\S*)(.*)$/);
    if (definition) {
        return esc(definition[1]) + mdToken(definition[2], "md-link") + esc(definition[3])
            + mdToken(definition[4], "md-url") + mdToken(definition[5], "md-mark");
    }
    let prefix = "";
    let rest = text;
    const quote = rest.match(/^ {0,3}>(?:[ \t]?>)*[ \t]?/);
    if (quote) {
        prefix += mdToken(quote[0], "md-mark");
        rest = rest.slice(quote[0].length);
    }
    const item = rest.match(/^(\s*)([-*+]|\d{1,9}[.)])(?=\s|$)(\s*)(\[[ xX]\](?=\s|$))?/);
    if (item) {
        prefix += esc(item[1]) + mdToken(item[2], "md-list") + esc(item[3]) + mdToken(item[4], "md-mark");
        rest = rest.slice(item[0].length);
    }
    if (/^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/.test(rest)) return prefix + mdToken(rest, "md-mark");
    const body = mdInline(rest, lexical, /^\s*\|/.test(rest));
    return prefix + (quote ? `<span class="md-quote">${body}</span>` : body);
}

function mdInline(text: string, lexical: LexicalState, table = false, depth = 0): string {
    // Delimiter matching rescans the line, so pathological lines stay plain.
    if (depth > 6 || text.length > 4000) return esc(text);
    const tokens = new RegExp(MD_INLINE);
    const out = [];
    let plain = 0;
    let match: RegExpExecArray | null;
    while ((match = tokens.exec(text))) {
        const token = match[0];
        if (token[0] === "\\") continue;
        const at = match.index;
        let end = tokens.lastIndex;
        let html = null;
        if (token[0] === "`") {
            const closing = /`+/g;
            closing.lastIndex = end;
            let close;
            while ((close = closing.exec(text)) && close[0].length !== token.length);
            if (close) {
                html = `<span class="md-code">${mdToken(token, "md-mark")}${esc(text.slice(end, close.index))}${mdToken(close[0], "md-mark")}</span>`;
                end = closing.lastIndex;
            }
        } else if (token === "<!--") {
            const close = text.indexOf("-->", end);
            if (close < 0) lexical.comment = "-->";
            end = close < 0 ? text.length : close + 3;
            html = mdToken(text.slice(at, end), "syn-comment");
        } else if (token.endsWith("[")) {
            MD_LINK.lastIndex = at;
            const link = MD_LINK.exec(text);
            if (link) {
                const [, label = "", url, title, ref] = link;
                end = MD_LINK.lastIndex;
                const head = `${mdToken(token, "md-mark")}<span class="md-link">${mdInline(label, {}, false, depth + 1)}</span>`;
                html = url != null
                    ? `${head}${mdToken("](", "md-mark")}${mdToken(url, "md-url")}${mdToken(title, "md-mark")}${mdToken(")", "md-mark")}`
                    : `${head}${mdToken("][", "md-mark")}${mdToken(ref, "md-url")}${mdToken("]", "md-mark")}`;
            }
        } else if (/^<(?:https?:|mailto:)/.test(token)) {
            html = `${mdToken("<", "md-mark")}${mdToken(token.slice(1, -1), "md-url")}${mdToken(">", "md-mark")}`;
        } else if (token.startsWith("<")) {
            html = mdToken(token, "md-html");
        } else if (token.startsWith("http")) {
            html = mdToken(token, "md-url");
        } else if (token === "|") {
            if (table) html = mdToken(token, "md-mark");
        } else {
            const mark = token[0];
            if (mark === "_" && /[\p{L}\p{N}]/u.test(text[at - 1] ?? "")) continue;
            const c = mark === "*" ? "\\*" : mark;
            const closing = new RegExp(`(?=[^\\s${c}])(.*?[^\\s\\\\${c}])${c.repeat(token.length)}(?!${c})${mark === "_" ? "(?![\\p{L}\\p{N}])" : ""}`, "uy");
            closing.lastIndex = end;
            const close = closing.exec(text);
            if (close) {
                end = closing.lastIndex;
                html = `<span class="md-${MD_STYLES[token]}">${mdToken(token, "md-mark")}${mdInline(close[1], {}, table, depth + 1)}${mdToken(token, "md-mark")}</span>`;
            }
        }
        if (html == null) continue;
        if (at > plain) out.push(esc(text.slice(plain, at)));
        out.push(html);
        plain = tokens.lastIndex = end;
    }
    if (plain < text.length) out.push(esc(text.slice(plain)));
    return out.join("");
}

function highlightFile(file: DiffFile): string[][] {
    const cached = highlightedFiles.get(file);
    if (cached) return cached;
    const language = syntaxLanguage(file.path);
    const sides: Record<DiffSide, { next: number | null; lexical: LexicalState }> = {
        old: { next: null, lexical: {} }, new: { next: null, lexical: {} },
    };
    const rows = file.hunks.map((hunk) => hunk.rows.map((row) => {
        let html: string | undefined;
        const lineSides: Array<[DiffSide, number | null | undefined]> = [["old", row.o], ["new", row.n]];
        for (const [side, line] of lineSides) {
            if (line == null) continue;
            const cursor = sides[side];
            // Omitted diff context cannot establish a multiline token's state.
            if (cursor.next !== line) cursor.lexical = {};
            html = highlightLine(row.s, language, cursor.lexical);
            cursor.next = line + 1;
        }
        return html ?? esc(row.s);
    }));
    highlightedFiles.set(file, rows);
    return rows;
}

function inline(text: string): string {
    return text
        .split(/(`[^`\n]+`)/)
        .map((part) => (part.length > 1 && part.startsWith("`") && part.endsWith("`")
            ? `<code>${esc(part.slice(1, -1))}</code>`
            : esc(part).replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")))
        .join("");
}

function md(text: string): string {
    const out: string[] = [];
    let para: string[] = [];
    let code: string[] | null = null;
    let list: "ol" | "ul" | null = null;
    const flush = () => {
        if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
        para = [];
        if (list) out.push(`</${list}>`);
        list = null;
    };
    for (const line of String(text ?? "").replace(/\r/g, "").split("\n")) {
        if (code) {
            if (/^\s*```/.test(line)) {
                out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
                code = null;
            } else code.push(line);
            continue;
        }
        if (/^\s*```/.test(line)) {
            flush();
            code = [];
        } else if (!line.trim()) flush();
        else if (/^#{1,6}\s/.test(line)) {
            flush();
            const heading = line.match(/^(#{1,6})\s+(.*)$/);
            if (!heading) continue;
            const [, hashes, title] = heading;
            out.push(`<h${hashes.length}>${inline(title)}</h${hashes.length}>`);
        } else if (/^(?:[-*]|\d+\.)\s+/.test(line)) {
            const match = line.match(/^([-*]|\d+\.)\s+(.*)$/);
            if (!match) continue;
            const [, bullet, item] = match;
            const tag = /^\d/.test(bullet) ? "ol" : "ul";
            if (list !== tag) {
                flush();
                out.push(`<${tag}>`);
                list = tag;
            }
            out.push(`<li>${inline(item)}</li>`);
        } else {
            if (list) flush();
            para.push(line);
        }
    }
    if (code) out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
    flush();
    return `<div class="md">${out.join("")}</div>`;
}

function ago(iso: string | null | undefined): string {
    if (!iso) return "";
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 45) return "just now";
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return new Date(iso).toLocaleString();
}

function uuid() {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

// ---------- API ----------

async function api(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { "X-MR-Token": TOKEN };
    if (state.review) headers["X-MR-Review"] = state.review.reviewId;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`/api/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json: unknown = await res.json().catch(() => ({}));
    // The server switched reviews under this page; catch up so the next attempt targets the review on screen.
    if (res.status === 409) scheduleReload();
    const error = isRecord(json) && isRecord(json.error) && typeof json.error.message === "string" ? json.error.message : null;
    if (!res.ok) throw new Error(error ?? `${res.status} ${res.statusText}`);
    return json;
}

// A scope switch points this page at a different review; nothing derived from the previous one may carry over.
function resetForReview() {
    persistPinnedComposers();
    pinnedComposers.clear();
    composerContexts.clear();
    state.snapshot = null;
    state.view = { type: "overview" };
    state.selection = null;
    state.pendingJump = null;
    state.open.clear();
    state.pending.clear();
    state.expanded.clear();
    state.collapsedThreads.clear();
    state.fileFold.clear();
    state.content.clear();
    state.collapsedDirs = null;
    viewRestored = false;
}

let loading: Promise<void> | null = null;
let reloadAgain = false;
async function loadState() {
    if (loading) {
        reloadAgain = true;
        return loading;
    }
    loading = (async () => {
        do {
            reloadAgain = false;
            const data = parseState(await api("GET", "state"));
            const rev = data.review.currentRevisionId;
            const snapshot = !rev ? null : state.review?.reviewId !== data.review.reviewId || state.snapshot?.revisionId !== rev
                ? parseSnapshot(await api("GET", `snapshot/${rev}`)) : state.snapshot;
            const reviewChanged = state.review?.reviewId !== data.review.reviewId;
            if (state.review && reviewChanged) resetForReview();
            else if (state.review && state.review.currentRevisionId !== data.review.currentRevisionId) pinComposers();
            state.review = data.review;
            if (reviewChanged) restorePinnedComposers(data.review.reviewId);
            state.snapshot = snapshot;
            state.reviewSkillsAvailable = data.reviewSkillsAvailable === true;
            state.pullRequest = data.pullRequest ?? null;
            const settingsState = settingsApi.readState(data.settingsPayload);
            state.settings = settingsState.settings;
            state.agentReviewAvailable = data.agentReviewAvailable;
            state.agentReviewSettings = settingsState.agentReviewSettings;
            state.agentReviewSettingsAvailable = settingsState.agentReviewSettingsAvailable;
            state.agentReviewSettingsError = settingsState.agentReviewSettingsError ?? "";
            state.agentReviewSuggestedModels = data.agentReviewSuggestedModels;
            if (data.session) state.busy = data.session.busy;
            restoreView();
            render();
        } while (reloadAgain);
    })().finally(() => {
        loading = null;
    });
    return loading;
}

let reloadTimer: number | undefined;
function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = window.setTimeout(() => loadState().catch((err: unknown) => toast(errorMessage(err), true)), 120);
}

function connect() {
    const es = new EventSource(`/api/events?t=${encodeURIComponent(TOKEN)}`);
    es.addEventListener("hello", (event: MessageEvent<string>) => {
        state.connection = "open";
        const payload: unknown = JSON.parse(event.data);
        state.busy = isRecord(payload) && typeof payload.busy === "boolean" ? payload.busy : null;
        scheduleReload();
    });
    es.addEventListener("changed", scheduleReload);
    // The extension's web assets changed on disk (dev hot reload).
    es.addEventListener("assets", () => location.reload());
    es.addEventListener("session", (event: MessageEvent<string>) => {
        const payload: unknown = JSON.parse(event.data);
        state.busy = isRecord(payload) && typeof payload.busy === "boolean" ? payload.busy : null;
        renderTop();
    });
    es.onerror = () => {
        state.connection = "lost";
        renderTop();
    };
}

// ---------- Drafts & view persistence ----------

const draftKey = (key: string) => `sr:${state.review?.reviewId}:draft:${key}`;
const getDraft = (key: string) => localStorage.getItem(draftKey(key)) ?? "";
function setDraft(key: string, value: string): void {
    if (value) localStorage.setItem(draftKey(key), value);
    else localStorage.removeItem(draftKey(key));
}

function saveView(): void {
    if (state.review) sessionStorage.setItem(`sr:${state.review.reviewId}:view`, JSON.stringify(state.view));
}
let viewRestored = false;
function restoreView(): void {
    if (viewRestored || !state.review) return;
    viewRestored = true;
    try {
        const value: unknown = JSON.parse(sessionStorage.getItem(`sr:${state.review.reviewId}:view`) ?? "null");
        if (isView(value)) state.view = value;
    } catch { /* ignore */ }
}

function collapsedDirs(): Set<string> {
    if (!state.collapsedDirs) {
        try {
            const value: unknown = JSON.parse(localStorage.getItem(`sr:${state.review?.reviewId}:collapsed`) ?? "[]");
            state.collapsedDirs = isStringArray(value) ? new Set(value) : new Set();
        } catch {
            state.collapsedDirs = new Set();
        }
    }
    return state.collapsedDirs;
}
function setDirCollapsed(dir: string, collapsed: boolean): void {
    const review = state.review;
    if (!review) return;
    const set = collapsedDirs();
    if (collapsed) set.add(dir);
    else set.delete(dir);
    localStorage.setItem(`sr:${review.reviewId}:collapsed`, JSON.stringify([...set]));
}
function expandAncestors(path: string): void {
    for (const dir of collapsedDirs()) {
        if (dir === "" || path.startsWith(`${dir}/`)) setDirCollapsed(dir, false);
    }
}

// ---------- File tree ----------

const inDir = (path: string, dir: string) => dir === "" || path.startsWith(`${dir}/`);
const filesUnder = (dir: string) => (state.snapshot?.files ?? []).filter((f) => inDir(f.path, dir)).sort((a, b) => a.path.localeCompare(b.path));
const repoName = () => (state.review?.repoRoot ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "All files";

// Folders first, then files; chains of single-child folders are compacted like ADO ("src/Common/Foo").
function buildTree(files: DiffFile[]): FileTreeNode {
    const root: FileTreeNode = { name: repoName(), path: "", dirs: new Map<string, FileTreeNode>(), files: [], children: [] };
    for (const f of files) {
        const parts = f.path.split("/");
        let node = root;
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            if (part === undefined) continue;
            if (!node.dirs.has(part)) node.dirs.set(part, { name: part, path: parts.slice(0, i + 1).join("/"), dirs: new Map<string, FileTreeNode>(), files: [], children: [] });
            const next = node.dirs.get(part);
            if (next) node = next;
        }
        node.files.push(f);
    }
    const finish = (node: FileTreeNode): FileTreeNode => {
        node.children = [...node.dirs.values()].map((dir) => {
            let d = dir;
            while (!d.files.length && d.dirs.size === 1) {
                const only = d.dirs.values().next().value;
                if (!only) break;
                d = { ...only, name: `${d.name}/${only.name}` };
            }
            return finish(d);
        }).sort((a, b) => a.name.localeCompare(b.name));
        node.files.sort((a, b) => a.path.localeCompare(b.path));
        return node;
    };
    return finish(root);
}

// ---------- Diff helpers ----------

function hunkAnchorRange(hunk: DiffHunk): { side: DiffSide; startLine: number; endLine: number } | null {
    const side = hunk.rows.some((r) => r.t === "add") ? "new" : "old";
    const key = side === "old" ? "o" : "n";
    const nums = hunk.rows.map((r) => r[key]).filter((v) => v != null);
    return nums.length ? { side, startLine: Math.min(...nums), endLine: Math.max(...nums) } : null;
}

function selectionRange(file: DiffFile, sel: Selection): { side: DiffSide; startLine: number; endLine: number } {
    const rows = file.hunks[sel.hunk].rows.slice(sel.from, sel.to + 1);
    const side = rows.every((r) => r.t === "del") ? "old" : "new";
    const key = side === "old" ? "o" : "n";
    const nums = rows.map((r) => r[key]).filter((v) => v != null);
    return { side, startLine: Math.min(...nums), endLine: Math.max(...nums) };
}

const fileOf = (p: string | undefined) => state.snapshot?.files.find((f) => f.path === p) ?? null;

// ADO parity: selecting a file shows the whole file (changes inline); folders show diffs only.
// The full view interleaves unchanged "gap" hunks with the snapshot hunks, so selection,
// placement, and anchoring keep working on the same { hunks: [{ rows }] } shape.
function needsContent(file: DiffFile): boolean {
    return !file.binary && file.status !== "added" && file.status !== "deleted" && file.hunks.length > 0;
}

function contentEntry(file: DiffFile): ContentEntry {
    const rev = state.snapshot?.revisionId;
    if (!rev) return { status: "unavailable", reason: "missing" };
    const key = `${rev}:${file.path}`;
    let entry = state.content.get(key);
    if (!entry) {
        entry = { status: "loading" };
        state.content.set(key, entry);
        api("GET", `content/${encodeURIComponent(rev)}?path=${encodeURIComponent(file.path)}`)
            .then((data) => { state.content.set(key, parseContent(data, file)); })
            .catch((err: unknown) => { state.content.set(key, { status: "unavailable", reason: errorMessage(err) }); })
            .finally(() => {
                if (state.view.type === "file" && state.view.path === file.path && !state.dragging) {
                    render();
                    revealPendingJump();
                }
            });
    }
    return entry ?? { status: "loading" };
}

function buildFullFile(file: DiffFile, lines: string[]): DiffFile {
    const hunks: DiffHunk[] = [];
    let nextNew = 1;
    let nextOld = 1;
    const gap = (untilNew: number): void => {
        const rows: DiffRow[] = [];
        for (let n = nextNew; n < untilNew; n++) rows.push({ t: "ctx", o: nextOld + (n - nextNew), n, s: lines[n - 1] ?? "" });
        if (rows.length) hunks.push({ gap: true, rows });
        nextOld += Math.max(0, untilNew - nextNew);
        nextNew = Math.max(nextNew, untilNew);
    };
    for (const hunk of file.hunks) {
        const newStart = hunk.newStart ?? 1;
        const newLines = hunk.newLines ?? 0;
        const oldStart = hunk.oldStart ?? 1;
        const oldLines = hunk.oldLines ?? 0;
        gap(newLines > 0 ? newStart : newStart + 1);
        hunks.push(hunk);
        nextNew = (newLines > 0 ? newStart : newStart + 1) + newLines;
        nextOld = (oldLines > 0 ? oldStart : oldStart + 1) + oldLines;
    }
    gap(lines.length + 1);
    return { ...file, hunks, full: true };
}

// The file object rendered for a path in the current view: full file in file view when loaded.
function displayFile(path: string): DiffFile | null {
    const file = fileOf(path);
    if (!file || state.view.type !== "file" || state.view.path !== path || !needsContent(file)) return file;
    const entry = contentEntry(file);
    if (state.selection?.path === path && state.selection.full === false) return file;
    return entry.status === "ready" ? entry.full : file;
}

// Where a thread renders inside a file view, or null when it cannot be placed in the diff.
function placeThread(thread: ReviewThread, file: DiffFile | null): { where: "file" } | { where: "hunk"; hunk: number } | { where: "row"; hunk: number; row: number } | null {
    const loc = thread.location;
    if (!file || !loc || loc.path !== file.path) return null;
    if (thread.kind === "file") return { where: "file" };
    if (loc.state === "outdated") return null;
    if (loc.startLine === undefined || loc.endLine === undefined) return null;
    const key = loc.side === "old" ? "o" : "n";
    for (let h = 0; h < file.hunks.length; h++) {
        const hunk = file.hunks[h];
        if (thread.kind === "change") {
            if (hunk.gap) continue;
            const r = hunkAnchorRange(hunk);
            if (r && r.side === loc.side && r.startLine <= loc.endLine && r.endLine >= loc.startLine) return { where: "hunk", hunk: h };
            continue;
        }
        for (let i = hunk.rows.length - 1; i >= 0; i--) {
            if (hunk.rows[i][key] === loc.endLine) return { where: "row", hunk: h, row: i };
        }
    }
    return null;
}

function isPlaced(thread: ReviewThread): boolean {
    if (thread.kind === "overview") return true;
    return placeThread(thread, fileOf(thread.location?.path)) !== null;
}

function lineLabel(loc: Partial<ThreadLocation> | null | undefined): string {
    if (!loc || loc.startLine == null) return "";
    return loc.startLine === loc.endLine ? `L${loc.startLine}` : `L${loc.startLine}–${loc.endLine}`;
}

function locLabel(thread: ReviewThread): string {
    const loc: Partial<ThreadLocation> = thread.location ?? thread.anchor ?? {};
    if (thread.kind === "overview") return "Overall";
    if (thread.kind === "file") return loc.path ?? "";
    return `${loc.path ?? ""} ${lineLabel(loc)}${loc.side === "old" ? " (old)" : ""}`;
}

const STATUS_LETTER: Record<DiffFile["status"], string> = { modified: "M", added: "A", deleted: "D", renamed: "R" };

// ---------- Rendering ----------

function render() {
    const active = document.activeElement;
    const focusKey = active instanceof HTMLTextAreaElement ? active.dataset.composer : undefined;
    const selStart = active instanceof HTMLTextAreaElement ? active.selectionStart : null;
    const selEnd = active instanceof HTMLTextAreaElement ? active.selectionEnd : null;
    const main = $("#main");
    if (!main) return;
    const scroll = main.scrollTop;
    renderTop();
    renderBanner();
    renderSide();
    renderMain();
    if (pinnedComposers.size) {
        main.innerHTML = [...pinnedComposers].map(([key, options]) =>
            `<div class="thread"><div class="muted">Diff changed. This comment keeps its original location in ${esc(options.revisionId)}.</div>${composerHtml(key, options)}</div>`,
        ).join("") + main.innerHTML;
    }
    main.scrollTop = scroll;
    renderRuler();
    if (focusKey) {
        const el = document.querySelector<HTMLTextAreaElement>(`textarea[data-composer="${CSS.escape(focusKey)}"]`);
        if (el) {
            el.focus();
            if (selStart != null) el.setSelectionRange(selStart, selEnd);
        }
    }
}

function scopeToggleHtml(scope: Scope): string {
    const button = (value: Scope, label: string, title: string) => `<button type="button" data-action="scope" data-scope="${value}" aria-pressed="${scope === value}" title="${esc(title)}"${state.switching ? " disabled" : ""}>${label}</button>`;
    return `<span class="seg" role="group" aria-label="Review scope">`
        + button("all", "All changes", "Everything on this branch since it diverged from the base, plus uncommitted work")
        + button("pending", "Pending changes", "Only uncommitted work: staged, unstaged and untracked files compared with HEAD")
        + `</span>`;
}

function renderTop() {
    const r = state.review;
    if (!r) return;
    const rev = r.revisions.find((x) => x.revisionId === r.currentRevisionId);
    const git = r.git ?? {};
    const scope = scopeOf(r);
    const awaiting = r.threads.flatMap((t) => t.messages).filter((m) => m.delivery && ["queued", "processing"].includes(m.delivery.state)).length;
    const branch = `<span class="pill mono" title="HEAD ${esc(git.headCommit ?? "")}">${esc(r.branch ?? "?")}</span>`;
    const parts = [
        `<section class="change-context" role="group" aria-label="Change context">`,
        `<div class="change-context-heading"><span class="title">${esc(r.title)}</span>${branch}`,
        scope === "all" ? `<span class="muted">vs</span><span class="pill mono" title="merge-base ${esc(git.baseCommit ?? "")}">${esc(r.base)}</span>`
            : `<span class="muted">uncommitted changes only</span>`,
        state.pullRequest ? `<a class="pill pr-link" href="${esc(state.pullRequest.url)}" target="_blank" rel="noopener noreferrer" title="Open pull request #${esc(state.pullRequest.number)} in browser">Open PR #${esc(state.pullRequest.number)}</a>` : "",
        `</div><div class="change-context-details">${scopeToggleHtml(scope)}`,
    ];
    if (rev) parts.push(`<span class="pill" title="Revision captured ${esc(rev.createdAt)}">${esc(rev.revisionId)} · ${rev.files} files · <span class="add">+${rev.additions}</span> <span class="del">−${rev.deletions}</span></span>`);
    if (scope === "all") {
        if (git.upstream) {
            const { ahead, behind, name } = git.upstream;
            const countsUnavailable = ahead === null || behind === null;
            const countLabel = countsUnavailable ? "↑? ↓?" : `↑${ahead} ↓${behind}`;
            const hasChanges = !countsUnavailable && (ahead !== 0 || behind !== 0);
            parts.push(`<span class="pill${countsUnavailable || hasChanges ? " warn" : ""}" title="${esc(name)}">${countLabel}</span>`);
        } else if (git.branch) parts.push(`<span class="pill warn">no upstream</span>`);
        if (git.uncommittedFiles) parts.push(`<span class="pill warn" title="Diff includes working-tree changes">${git.uncommittedFiles} uncommitted</span>`);
    }
    if (state.connection === "lost") parts.push(`<span class="pill warn" title="If this persists, reopen the canvas">disconnected</span>`);
    else if (state.busy === true) parts.push(`<span class="pill busy"><span class="dot"></span>Copilot working${awaiting ? ` · ${awaiting} pending` : ""}</span>`);
    else if (state.busy === false) parts.push(`<span class="pill"><span class="dot muted"></span>Copilot idle${awaiting ? ` · ${awaiting} pending` : ""}</span>`);
    parts.push(`<span class="spacer"></span><button data-action="refresh" title="Re-read the working tree">Refresh</button></div></section>`);

    const drafts = draftMessages().length;
    const workflows = [];
    if (state.agentReviewAvailable) {
        const running = r.agentReviews?.some((run) => ["sending", "queued", "running"].includes(run.state));
        const defaults = state.agentReviewSettings;
        const hint = defaults?.skipDialog
            ? `Run with saved defaults: ${defaults.models.join(", ")} (${defaults.focus}). May consume credits.`
            : "Configure and run a read-only agentic review. May consume credits.";
        workflows.push(`<section class="review-lane agent-review-lane" aria-labelledby="agentic-review-title">`
            + `<div class="review-lane-heading"><h2 id="agentic-review-title">Agentic review</h2><p class="muted">Independent, read-only model review. May consume credits.</p></div>`
            + `<div class="review-lane-actions">`
            + `<button class="primary agent-review-launch" data-action="agent-review" title="${esc(hint)}"${running || state.startingReview ? " disabled" : ""}>${running ? "Agentic review running" : state.startingReview ? "Queuing review..." : "Run agentic review"}</button>`
            + `<button data-action="agent-review-configure" title="Configure reviewers, focus, guidance, review skills, and user-wide defaults">Review settings</button>`
            + `</div></section>`);
    }
    workflows.push(`<section class="review-lane feedback-lane" aria-labelledby="manual-review-title">`
        + `<div class="review-lane-heading"><h2 id="manual-review-title">Manual Review</h2><p class="muted">Your comments guide the coding agent; these settings control how they are sent and learned from.</p></div>`
        + `<div class="review-lane-actions">`);
    workflows.push(`<span class="feedback-draft-count">${drafts} draft ${drafts === 1 ? "comment" : "comments"}</span>`);
    if (drafts) workflows.push(`<button class="primary" data-action="submit-review" title="Send every draft comment to Copilot together, as one review"${state.submitting ? " disabled>Submitting…" : `>Submit review (${drafts})`}</button>`);
    if (state.settings) {
        const repoMode = deliveryRepoMode();
        const chosen = repoMode === "ask" ? deliveryMode() : null;
        workflows.push(chosen
            ? `<span class="pill" title="${esc(DELIVERY[chosen].hint)} Chosen for this review.">Delivery: ${esc(DELIVERY[chosen].pill)}</span><button class="link" data-action="delivery-reask" title="Choose again how this review sends comments">Change</button>`
            : `<span class="pill" title="${esc(DELIVERY[repoMode].hint)}">Delivery: ${esc(DELIVERY[repoMode].pill)}</span>`);
        const mode = LEARNING[learningMode()];
        workflows.push(`<span class="pill" title="${esc(mode.hint)}">Learning: ${esc(mode.pill)}</span><button data-action="configure" title="Change how manual review comments are delivered and used for learning in this repository">Manual review settings</button>`);
    }
    workflows.push(`</div></section>`);
    if (workflows.length) parts.push(`<div class="review-workflows">${workflows.join("")}</div>`);
    requiredElement("#top").innerHTML = parts.join("");
}

// ---------- Repository settings: first-use banner, per-review delivery question, and Configure dialog ----------

function learningBannerHtml(): string {
    const s = state.settings;
    if (!s || s.configured || s.dismissed) return "";
    const choice = (mode: LearningMode, primary: boolean) => `<button data-action="learning-set" data-mode="${mode}"${primary ? ` class="primary"` : ""} title="${esc(LEARNING[mode].hint)}">${esc(LEARNING[mode].label)}</button>`;
    return `<div class="banner-row"><span class="banner-text"><strong>Learn from your review feedback in ${esc(s.repoName)}?</strong> Copilot can turn your comments into reusable coding guidelines. The choice is stored on this machine only, and Configure changes it any time.</span>`
        + `<span class="banner-actions">${choice("suggest", true)}${choice("auto", false)}`
        + `<button class="link" data-action="learning-dismiss" title="Hide this notice. Learning stays off until you choose a mode with Configure.">Not now</button></span></div>`;
}

// Shown while an ask-mode review is undecided; until then the server holds new comments as drafts.
function deliveryBannerHtml(): string {
    if (!state.settings || !state.review || deliveryRepoMode() !== "ask" || deliveryMode()) return "";
    const drafts = draftMessages().length;
    const waiting = drafts ? `${drafts} draft ${drafts === 1 ? "comment is" : "comments are"} waiting.` : "Until you choose, new comments wait as drafts.";
    const choice = (mode: Exclude<DeliveryMode, "ask">, label: string) => `<button data-action="delivery-choose" data-mode="${mode}" title="${esc(DELIVERY[mode].hint)}">${label}</button>`;
    return `<div class="banner-row"><span class="banner-text"><strong>How should Copilot receive your comments on this review?</strong> Send each one as you post it, or batch them and submit the review when you are done. ${waiting}</span>`
        + `<span class="banner-actions">${choice("immediate", "Send each now")}${choice("batch", "Batch into a review")}</span></div>`;
}

function bannerHtml(): string {
    return learningBannerHtml() + deliveryBannerHtml();
}

function renderBanner(): void {
    const el = $("#banner");
    const html = bannerHtml();
    if (!el) return;
    el.hidden = !html;
    el.innerHTML = html;
}

function choicesHtml<M extends string>(name: string, modes: readonly M[], table: Record<M, { label: string; hint: string }>, selected: M): string {
    return modes.map((mode) => `<label class="choice"><input type="radio" name="${name}" value="${mode}"${selected === mode ? " checked" : ""}>`
        + `<span><span class="choice-title">${esc(table[mode].label)}</span><span class="choice-hint">${esc(table[mode].hint)}</span></span></label>`).join("");
}

function dialogHtml(): string {
    const d = state.dialog;
    if (!d) return "";
    if (d.type === "agent-review") return agentReviewDialogHtml(d);
    return `<div class="modal-backdrop" data-action="dialog-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-desc">`
        + `<h2 id="dialog-title">Review settings</h2>`
        + `<p id="dialog-desc" class="muted">Settings for ${esc(state.settings?.repoName ?? "this repository")}. They are stored on this machine only and never committed.</p>`
        + `<fieldset class="choices"><legend>Learn from review feedback</legend>${choicesHtml("learning", LEARNING_MODES, LEARNING, d.learning)}</fieldset>`
        + `<fieldset class="choices"><legend>Send comments to Copilot</legend>${choicesHtml("delivery", DELIVERY_MODES, DELIVERY, d.delivery)}</fieldset>`
        + (d.error ? `<div class="modal-error" role="alert">${esc(d.error)}</div>` : "")
        + `<div class="modal-actions"><button data-action="dialog-cancel"${d.saving ? " disabled" : ""}>Cancel</button>`
        + `<button class="primary" data-action="dialog-save"${d.saving ? " disabled" : ""}>${d.saving ? "Saving…" : "Save"}</button></div>`
        + `</div></div>`;
}

function focusIn(selector: string): void {
    $(selector)?.focus?.();
}

// The dialog is rendered on its own so re-renders of the page never disturb its focus or radio state.
function renderDialog() {
    const active = document.activeElement instanceof HTMLElement && document.activeElement.closest("#dialog") ? document.activeElement : null;
    const key = active instanceof HTMLInputElement && active.name ? `[name="${active.name}"]${active.type === "checkbox" ? `[value="${CSS.escape(active.value)}"]` : ""}`
        : active instanceof HTMLSelectElement && active.name ? `[name="${active.name}"]`
        : active instanceof HTMLTextAreaElement && active.name ? `[name="${active.name}"]`
        : active?.dataset?.action ? `[data-action="${active.dataset.action}"]` : null;
    const selection = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
        ? [active.selectionStart, active.selectionEnd] as const : null;
    const dialog = $("#dialog");
    if (!dialog) return;
    dialog.innerHTML = dialogHtml();
    for (const id of ["#top", "#banner", "#layout"]) {
        const el = $(id);
        if (el) el.inert = Boolean(state.dialog);
    }
    const restored = key ? document.querySelector<HTMLElement>(`#dialog ${key}`) : null;
    if (restored && !("disabled" in restored && restored.disabled)) {
        restored.focus();
        if (selection && selection[0] !== null
            && (restored instanceof HTMLTextAreaElement || (restored instanceof HTMLInputElement && restored.type === "text"))) {
            restored.setSelectionRange(...selection);
        }
    }
}

function openConfigure() {
    if (!state.settings || state.dialog) return;
    state.dialog = { type: "configure", learning: learningMode(), delivery: deliveryRepoMode(), saving: false, error: "" };
    renderDialog();
    focusIn('#dialog input[name="learning"]:checked');
}

function closeConfigure() {
    if (!state.dialog || state.dialog.saving) return;
    const opener = state.dialog.type === "agent-review" ? state.dialog.opener ?? "agent-review" : "configure";
    state.dialog = null;
    renderDialog();
    focusIn(`[data-action="${opener}"]`);
}

function reviewSkillsSectionHtml(d: AgentReviewDialog): string {
    const disabled = d.saving || d.skillsLoading;
    const names = d.skillNames ?? [];
    const rows = (d.skillCatalog?.skills ?? []).map((skill) => {
        const source = `${skill.upstream.repository}/blob/${skill.upstream.release}/${skill.upstream.path}`;
        return `<label class="choice skill-choice"><input type="checkbox" name="review-skill" value="${esc(skill.name)}"${names.includes(skill.name) ? " checked" : ""}${disabled ? " disabled" : ""}>`
            + `<span><span class="skill-group-name">${esc(skill.title)}</span> <code>${esc(skill.name)}</code>${skill.role === "ponytail" ? " - separate top-level benefits note" : " - review guidance"}`
            + `<span class="choice-hint">${esc(skill.summary)}<br>Bundled with Self-Review: unmodified snapshot of <a href="${esc(source)}" target="_blank" rel="noopener noreferrer">${esc(skill.upstream.repository.replace("https://github.com/", ""))} ${esc(skill.upstream.release)}</a> (file commit ${esc(skill.upstream.fileCommit.slice(0, 7))}). License: ${esc(skill.license.spdx)}.`
            + `${skill.attribution ? `<br>${esc(skill.attribution)}` : ""}</span></span></label>`;
    }).join("");
    return `<fieldset class="choices review-skills-section"><legend>Review skills</legend>`
        + `<p class="muted">These skills ship with Self-Review and are on by default. Their full text is given to every reviewer in the run. Uncheck any you do not want; nothing is installed or downloaded.</p>`
        + (d.skillsLoading && !d.skillCatalog ? `<p class="muted" role="status">Loading bundled skills...</p>` : "")
        + rows
        + (d.skillsError ? `<div class="modal-error" role="alert">${esc(d.skillsError)}</div><button data-action="review-skills-refresh"${disabled ? " disabled" : ""}>Retry</button>` : "")
        + (state.agentReviewSettingsAvailable ? `<label class="choice"><input type="checkbox" name="review-skill-defaults"${d.saveSkillDefaults ? " checked" : ""}${disabled || !d.skillCatalog ? " disabled" : ""}><span>Save these skill choices as my defaults across repositories</span></label>` : "")
        + `<p class="muted">Unchecked choices apply to this review until you save them as defaults. Third-party notices and license texts are in the extension's bundled-skills folder.</p></fieldset>`;
}

async function refreshReviewSkills(): Promise<void> {
    const d = state.dialog;
    if (d?.type !== "agent-review" || d.saving || d.skillsLoading) return;
    d.skillsLoading = true;
    d.skillsError = "";
    renderDialog();
    try {
        const firstLoad = !d.skillCatalog;
        const catalog = parseSkillCatalog(await api("GET", "review-skills"));
        if (state.dialog !== d) return;
        d.skillCatalog = catalog;
        if (firstLoad && d.skillNames === undefined) {
            d.skillNames = [...catalog.selected];
        }
    } catch (err: unknown) {
        d.skillsError = errorMessage(err);
    } finally {
        d.skillsLoading = false;
        if (state.dialog === d) {
            renderDialog();
            if (!document.activeElement?.closest?.("#dialog")) focusIn(d.skillsError ? '#dialog [data-action="review-skills-refresh"]' : '#dialog [data-action="review-tab"][aria-selected="true"]');
        }
    }
}

function reviewTabsHtml(d: AgentReviewDialog): string {
    const tab = (id: "general" | "skills", label: string) => `<button role="tab" id="review-tab-${id}" class="review-tab" data-action="review-tab" data-tab="${id}" aria-controls="review-panel-${id}" aria-selected="${d.tab === id}">${label}</button>`;
    return `<div class="review-tabs" role="tablist" aria-label="Review settings sections">${tab("general", "General")}${tab("skills", "Review skills")}</div>`;
}

function agentReviewDialogHtml(d: AgentReviewDialog): string {
    const options = [["review", "Review issues"], ["simplify", "Simplification"], ["both", "Review and simplification"]];
    return `<div class="modal-backdrop" data-action="dialog-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-desc">`
        + (d.settingsOnly
            ? `<h2 id="dialog-title">Agent review settings</h2><p id="dialog-desc">Configure reviewers, focus, guidance, and review skills. Saving never starts a review; use Run agentic review in the toolbar.</p>`
            : `<h2 id="dialog-title">Agentic review</h2><p id="dialog-desc">Review ${esc(d.revisionId)} (${esc(d.scope)}). Each selected model reviews independently and may consume credits. No files are changed until you approve a suggestion or explicitly request a fix.</p>`)
        + reviewTabsHtml(d)
        + `<div role="tabpanel" id="review-panel-general" aria-labelledby="review-tab-general"${d.tab === "general" ? "" : " hidden"}>`
        + `<label class="review-field">Reviewers (one to four model IDs, comma-separated)<input name="review-models" value="${esc(d.models)}" maxlength="483" autocomplete="off"${d.saving ? " disabled" : ""}></label>`
        + `<p class="muted">Use exact model IDs available in your Copilot session, or copilot-fusion to run Copilot Fusion in a child session that reports back later. An unavailable reviewer is reported as a failure, never silently replaced.</p>`
        + `<label class="review-field"><span id="review-focus-label">Focus</span><select name="review-focus" aria-labelledby="review-focus-label"${d.saving ? " disabled" : ""}>${options.map(([value, label]) => `<option value="${value}"${d.focus === value ? " selected" : ""}>${label}</option>`).join("")}</select></label>`
        + `<label class="review-field">Goal, spec, or review guidance (optional)<textarea name="review-intent" maxlength="4000" rows="3" placeholder="Acceptance criteria, a spec reference, or focused review guidance"${d.saving ? " disabled" : ""}>${esc(d.intent)}</textarea></label>`
        + `<p class="muted">The coordinating agent checks findings against the code, baseline, and relevant callers or tests before reporting them. Missing evidence is reported, not treated as a pass.</p>`
        + (state.agentReviewSettingsAvailable
            ? `<fieldset class="choices"><legend>User defaults for all repositories</legend>`
                + `<label class="choice"><input type="checkbox" name="review-save-defaults"${d.saveDefaults ? " checked" : ""}${d.saving ? " disabled" : ""}><span>Save these models, focus, and guidance as my defaults</span></label>`
                + `<label class="choice"><input type="checkbox" name="review-skip-dialog"${d.skipDialog ? " checked" : ""}${d.saving || !d.saveDefaults ? " disabled" : ""}><span>Run with saved defaults without asking again</span></label>`
                + `<p class="muted">Each click on Run agentic review authorizes a credit-consuming review. Nothing runs on save or when opening a canvas. Fixes still need approval. Saved guidance applies across repositories; avoid repository-specific instructions.</p></fieldset>` : "")
        + `</div><div role="tabpanel" id="review-panel-skills" aria-labelledby="review-tab-skills"${d.tab === "skills" ? "" : " hidden"}>`
        + (state.reviewSkillsAvailable ? reviewSkillsSectionHtml(d) : `<p class="muted" role="status">Bundled review skills are unavailable in this build. Reviews run with the built-in guidance.</p>`)
        + `</div>`
        + (d.error ? `<div class="modal-error" role="alert">${esc(d.error)}</div>` : "")
        + `<div class="modal-actions"><button data-action="dialog-cancel"${d.saving ? " disabled" : ""}>Cancel</button>`
        + (state.agentReviewSettingsAvailable ? `<button${d.settingsOnly ? ' class="primary"' : ""} data-action="agent-review-save-defaults"${d.saving || d.skillsLoading || !(d.saveDefaults || d.saveSkillDefaults) ? " disabled" : ""}>Save defaults</button>` : "")
        + (d.settingsOnly && state.reviewSkillsAvailable ? `<button data-action="agent-review-apply-skills"${d.saving || d.skillsLoading || !d.skillCatalog ? " disabled" : ""}>Apply for this review</button>` : "")
        + (d.settingsOnly ? "" : `<button class="primary" data-action="agent-review-start"${d.saving || d.skillsLoading ? " disabled" : ""}>${d.saving ? "Please wait..." : "Run review"}</button>`)
        + `</div></div></div>`;
}

function openAgentReview(opener = "agent-review"): void {
    if (!state.agentReviewAvailable || !state.review || state.dialog) return;
    const revisionId = state.review.currentRevisionId;
    const last = state.review.agentReviews?.at(-1);
    const defaults = state.agentReviewSettings;
    state.dialog = {
        type: "agent-review", reviewId: state.review.reviewId, revisionId,
        scope: scopeLabel(scopeOf(state.review)), models: (defaults?.models ?? last?.models ?? state.agentReviewSuggestedModels).join(", "),
        focus: defaults?.focus ?? (isReviewFocus(last?.focus) ? last.focus : "review"), intent: defaults?.intent ?? "", saving: false,
        skillNames: state.skillOverrides.get(state.review.reviewId) ?? defaults?.skillNames,
        skillCatalog: null, skillsLoading: false, skillsError: "", saveSkillDefaults: false, tab: "general",
        saveDefaults: Boolean(defaults), skipDialog: defaults?.skipDialog ?? false, opener, settingsOnly: opener === "agent-review-configure", error: state.agentReviewSettingsError,
    };
    renderDialog();
    focusIn('#dialog input[name="review-models"]');
    if (state.reviewSkillsAvailable) refreshReviewSkills().catch((err: unknown) => toast(errorMessage(err), true));
}

function agentReviewOptions(d: AgentReviewDialog): import("../../types/contracts.js").AgentReviewOptions {
    return { models: d.models.split(",").map((m) => m.trim()), focus: d.focus, intent: d.intent,
        ...(d.skillNames !== undefined ? { skillNames: d.skillNames } : {}) };
}

async function saveAgentReviewDefaults(d: AgentReviewDialog): Promise<void> {
    const { skillNames: _skillNames, ...options } = agentReviewOptions(d);
    state.agentReviewSettings = await settingsApi.updateAgentReview({ ...options, skipDialog: d.skipDialog });
    state.agentReviewSettingsError = "";
}

async function startAgentReview(saveOnly = false): Promise<void> {
    const d = state.dialog;
    if (d?.type !== "agent-review" || d.saving || (d.settingsOnly && !saveOnly)) return;
    d.saving = true;
    d.error = "";
    renderDialog();
    try {
        if (!saveOnly && (d.reviewId !== state.review?.reviewId || d.revisionId !== state.review?.currentRevisionId)) {
            throw new Error("The review scope changed or revision is stale. Close this dialog and try again.");
        }
        if (saveOnly && !d.saveDefaults && !d.saveSkillDefaults) throw new Error("Select Save these models, focus, and guidance, or save skill choices, first.");
        if (d.saveDefaults) await saveAgentReviewDefaults(d);
        if (d.saveSkillDefaults) {
            if (d.reviewId !== state.review?.reviewId) throw new Error("The review changed. Close this dialog and try again.");
            await api("POST", "review-skills", { names: d.skillNames ?? [], saveDefaults: true });
        }
        if (d.skillCatalog && d.skillNames !== undefined) state.skillOverrides.set(d.reviewId, [...d.skillNames]);
        if (!saveOnly) {
            if (d.reviewId !== state.review?.reviewId || d.revisionId !== state.review?.currentRevisionId) {
                throw new Error("The review scope changed or revision is stale. Close this dialog and try again.");
            }
            await api("POST", "agent-reviews", { ...agentReviewOptions(d), revisionId: d.revisionId });
        }
        state.dialog = null;
        renderDialog();
        focusIn('[data-action="agent-review"]');
        await loadState();
        toast(saveOnly ? "User defaults saved. No review was started." : "Review requested. Model results will appear as suggestions.");
    } catch (err: unknown) {
        d.saving = false;
        d.error = errorMessage(err);
        if (state.dialog === d) renderDialog();
        await loadState().catch((loadError: unknown) => toast(errorMessage(loadError), true));
    }
}

function applyReviewSkills(): void {
    const d = state.dialog;
    if (d?.type !== "agent-review" || d.saving || !d.skillCatalog) return;
    if (d.reviewId !== state.review?.reviewId) {
        d.error = "The review changed. Close this dialog and try again.";
        renderDialog();
        return;
    }
    state.skillOverrides.set(d.reviewId, [...(d.skillNames ?? [])]);
    state.dialog = null;
    renderDialog();
    focusIn('[data-action="agent-review-configure"]');
    toast("Review skills applied to this review only. Defaults are unchanged and no review was started.");
}

async function runAgentReview(): Promise<void> {
    if (!state.agentReviewAvailable || !state.review || state.dialog || state.startingReview
        || state.review.agentReviews?.some((run) => ["sending", "queued", "running"].includes(run.state))) return;
    if (!state.agentReviewSettings?.skipDialog || state.agentReviewSettingsError) {
        openAgentReview();
        return;
    }
    const reviewId = state.review.reviewId;
    const revisionId = state.review.currentRevisionId;
    state.startingReview = true;
    renderTop();
    try {
        await loadState();
        if (state.review?.reviewId !== reviewId || state.review.currentRevisionId !== revisionId) {
            toast("The review scope or revision changed. Confirm the current review before starting.");
            return;
        }
        if (!state.agentReviewSettings?.skipDialog || state.agentReviewSettingsError) {
            openAgentReview();
            return;
        }
        const skillNames = state.skillOverrides.get(reviewId);
        await api("POST", "agent-reviews", { useDefaults: true, oneClick: true, revisionId, ...(skillNames !== undefined ? { skillNames } : {}) });
        toast("Review requested with your saved defaults.");
    } finally {
        state.startingReview = false;
        renderTop();
        await loadState();
    }
}

function agentComments(): Array<ReviewThread & { agentReview: FindingReport }> {
    return state.review?.threads.filter((thread): thread is ReviewThread & { agentReview: FindingReport } => Boolean(thread.agentReview)) ?? [];
}

function agentCommentsView(): string {
    const review = state.review;
    if (!review) return "";
    const threads = agentComments();
    const active = threads.filter((thread) => thread.status === "active").length;
    const older = threads.filter((thread) => thread.agentReview.revisionId !== review.currentRevisionId).length;
    return `<h2>Agent reviews</h2>`
        + agentReviewsHtml()
        + `<h2>Agent comments (<span aria-live="polite">${threads.length}</span>)</h2>`
        + `<p class="muted">${active} active, ${threads.length - active} closed or resolved; ${older} from older revisions. Counts include all agent findings in this scope, not replies or manual threads.</p>`
        + (threads.length ? threads.map((thread) => threadHtml(thread, { showLocation: true })).join("") : `<div class="empty">No agent comments yet. A review may still be running or may have reported no findings; check its status above.</div>`);
}

function agentReviewsHtml(): string {
    const review = state.review;
    const runs = review?.agentReviews ?? [];
    if (!runs.length) return "";
    const active = (r: AgentReviewRun) => ["sending", "queued", "running"].includes(r.state);
    return `<h3>Review runs</h3><p class="muted">Assessments and verification are reported by the coordinating agent, not independently attested by the canvas.</p>${[...runs].reverse().map((r) => `<div class="card agent-review-run">`
        + `<strong>${esc(r.focus)}: ${esc(r.state)}</strong> <span class="pill">${agentComments().filter((thread) => thread.agentReview.runId === r.runId).length} agent comments</span> <span class="muted">${esc(r.revisionId)}${r.revisionId !== review?.currentRevisionId ? " (older diff)" : ""}</span>`
        + (r.intent ? `<p class="review-summary">Goal / spec / guidance: ${esc(r.intent)}</p>` : "")
        + (r.skills?.length ? `<p class="review-summary">Bundled skills supplied: ${esc(r.skills.map((skill) => skill.release ? `${skill.name} (${skill.release})` : skill.name).join(", "))}. See actual use and limits in each result.</p>` : "")
        + (r.error ? `<p class="err">${esc(r.error)}</p>` : "")
        + `<ul>${r.models.map((model) => {
            const result = r.results.find((x) => x.model === model);
            let outcome = active(r) ? (model === "copilot-fusion" ? "Awaiting result from the Copilot Fusion child session" : "Awaiting result") : "Not completed";
            if (result) {
                if (result.error) {
                    outcome = `Failed: ${esc(result.error)}`;
                } else {
                    const counts: Record<string, number> = {};
                    for (const id of result.threadIds) {
                        const assessment = review?.threads.find((t) => t.threadId === id)?.agentReview?.assessment;
                        const key = typeof assessment === "string" && Object.hasOwn(FINDING_ASSESSMENTS, assessment) ? assessment : "unverified";
                        counts[key] = (counts[key] ?? 0) + 1;
                    }
                    outcome = result.threadIds.length ? Object.keys(FINDING_ASSESSMENTS).filter((key) => counts[key]).map((key) => `${counts[key]} ${key}`).join(", ") : "No findings reported";
                    outcome += `<details><summary>Coverage and verification</summary><p class="review-summary">${esc(result.summary ?? "No coverage or verification summary recorded.")}</p></details>`;
                    if (result.ponytail) {
                        const report = result.ponytail;
                        outcome += `<details><summary>Ponytail: ${report.status === "used" ? report.benefits.length ? `${report.benefits.length} supported opportunities` : "no supported benefits" : "unavailable / not loaded"}</summary>`
                            + `<p class="review-summary">${esc(report.summary)}</p>`
                            + report.benefits.map((entry) => `<div class="review-summary"><strong>${esc(entry.proposal)}</strong><p>${esc(entry.benefit)}</p><p>Source: ${esc(entry.evidence.source)}<br>Baseline: ${esc(entry.evidence.baseline)}<br>Validation/limits: ${esc(entry.evidence.validation)}</p></div>`).join("")
                            + `</details>`;
                    }
                }
            }
            return `<li><span class="mono">${esc(model)}</span>: ${outcome}</li>`;
        }).join("")}</ul>`
        + (active(r) ? `<button data-action="agent-review-close" data-run="${esc(r.runId)}" title="Stop accepting results for this review. This does not stop agents already running.">Close review</button>` : "")
        + `</div>`).join("")}`;
}

// A delivery change alters every composer's buttons, so it needs a full render once a diff is shown.
async function updateSettings(patch: import("../../types/contracts.js").SettingsPatch): Promise<void> {
    const before = deliveryMode();
    state.settings = await settingsApi.update(patch);
    if (deliveryMode() !== before && state.snapshot) {
        render();
    } else {
        renderTop();
        renderBanner();
    }
}

async function saveConfigure(): Promise<void> {
    const d = state.dialog;
    if (!d || d.type !== "configure" || d.saving) return;
    d.saving = true;
    d.error = "";
    renderDialog();
    try {
        await updateSettings({ learning: d.learning, delivery: d.delivery });
        state.dialog = null;
        renderDialog();
        focusIn('[data-action="configure"]');
        toast(`Saved. Learning: ${LEARNING[learningMode()].pill} · Delivery: ${DELIVERY[deliveryRepoMode()].pill}`);
    } catch (err: unknown) {
        d.saving = false;
        d.error = errorMessage(err);
        renderDialog();
        focusIn('#dialog [data-action="dialog-save"]');
    }
}

// Keeps Tab inside the open dialog; each radio group is a single tab stop (its checked radio).
function trapTab(e: KeyboardEvent): void {
    const groupStop = (name: string): HTMLInputElement | undefined => {
        const radios = Array.from(document.querySelectorAll<HTMLInputElement>(`#dialog input[name="${name}"]`));
        return radios.find((x) => x.checked) ?? radios[0];
    };
    const stops: HTMLElement[] = state.dialog?.type === "agent-review"
        ? Array.from(document.querySelectorAll<HTMLElement>("#dialog input:not([disabled]), #dialog select:not([disabled]), #dialog textarea:not([disabled]), #dialog a[href], #dialog button:not([disabled])"))
        : [groupStop("learning"), groupStop("delivery"), ...Array.from(document.querySelectorAll<HTMLButtonElement>("#dialog button:not([disabled])"))]
            .filter((el): el is HTMLInputElement | HTMLButtonElement => el instanceof HTMLInputElement || el instanceof HTMLButtonElement);
    if (!stops.length) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
    }
}

async function switchScope(scope: Scope): Promise<void> {
    if (state.switching || scope === scopeOf(state.review)) return;
    state.switching = true;
    renderTop();
    try {
        await api("POST", "scope", { scope });
        await loadState();
    } finally {
        state.switching = false;
        renderTop();
        renderSide();
    }
}

function activeCount(pathName: string): number {
    return state.review?.threads.filter((t) => t.status === "active" && t.kind !== "overview" && t.location?.path === pathName).length ?? 0;
}

const CHEVRON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const FOLDER_ICON = `<svg class="ficon" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 3h4.1l1.5 1.5h6.9c.41 0 .75.34.75.75v7c0 .41-.34.75-.75.75H1.75A.75.75 0 0 1 1 12.25v-8.5c0-.41.34-.75.75-.75Z" fill="currentColor"/></svg>`;

const statHtml = (adds: number, dels: number) => `<span class="stat"><span class="add">+${adds}</span> <span class="del">−${dels}</span></span>`;

function treeHtml(node: FileTreeNode, depth: number, out: string[]): void {
    const review = state.review;
    if (!review) return;
    const v = state.view;
    const collapsed = collapsedDirs().has(node.path);
    const files = filesUnder(node.path);
    const n = files.reduce((sum, f) => sum + activeCount(f.path), 0);
    const title = node.path === "" ? `${review.repoRoot} — ${scopeLabel(scopeOf(review))}` : node.path;
    out.push(`<div class="nav-item tree dir${v.type === "folder" && v.path === node.path ? " active" : ""}" data-action="nav" data-view="folder" data-path="${esc(node.path)}" style="--depth:${depth}" title="${esc(title)}" role="treeitem" aria-expanded="${!collapsed}">`
        + `<span class="twisty${collapsed ? "" : " open"}" data-action="fold" data-path="${esc(node.path)}" title="${collapsed ? "Expand" : "Collapse"}">${CHEVRON}</span>`
        + FOLDER_ICON
        + `<span class="name">${esc(node.name)}</span>`
        + `<span class="count${n ? "" : " zero"}">${n}</span>`
        + `</div>`);
    if (collapsed) return;
    for (const child of node.children) treeHtml(child, depth + 1, out);
    for (const f of node.files) {
        const letter = STATUS_LETTER[f.status] ?? "M";
        const fn = activeCount(f.path);
        out.push(`<div class="nav-item tree${v.type === "file" && v.path === f.path ? " active" : ""}" data-action="nav" data-view="file" data-path="${esc(f.path)}" style="--depth:${depth + 1}" title="${esc(f.path)}${f.untracked ? " (untracked)" : ""}" role="treeitem">`
            + `<span class="twisty spacer-twisty"></span>`
            + `<span class="status-letter ${letter}">${letter}</span>`
            + `<span class="name">${esc(f.path.slice(f.path.lastIndexOf("/") + 1))}</span>`
            + `<span class="count${fn ? "" : " zero"}">${fn}</span>`
            + `${statHtml(f.additions, f.deletions)}</div>`);
    }
}

function setAllDirsCollapsed(collapse: boolean): void {
    const review = state.review;
    if (!review) return;
    const dirs: string[] = [];
    const walk = (node: FileTreeNode): void => {
        for (const child of node.children) {
            dirs.push(child.path);
            walk(child);
        }
    };
    if (collapse) walk(buildTree(state.snapshot?.files ?? []));
    state.collapsedDirs = new Set(dirs);
    localStorage.setItem(`sr:${review.reviewId}:collapsed`, JSON.stringify(dirs));
}

function descriptionHtml(): string {
    const review = state.review;
    if (!review) return "";
    const d = review.description;
    const stale = d && d.revisionId !== review.currentRevisionId;
    return `<div class="section-head"><h2>Change overview</h2><span class="spacer"></span>`
        + `<button data-action="discuss-description">Discuss / request edits</button></div>`
        + `<div class="card description"><div class="muted">Local PR-style draft; not synced to the published PR.`
        + (d ? ` v${d.version} · based on ${esc(d.revisionId)}${stale ? " · Diff changed; description may need updating." : ""}` : "")
        + `</div>${d ? md(d.body) : `<div class="empty">No description yet. Ask Copilot below to describe the purpose, behavior, scope, verification, and risks.</div>`}</div>`;
}

function renderSide(): void {
    const r = state.review;
    if (!r) return;
    const files = state.snapshot?.files ?? [];
    const v = state.view;
    const overviewCount = r.threads.filter((t) => t.status === "active" && (t.kind === "overview" || !isPlaced(t))).length;
    const html = [
        `<div class="nav-item${v.type === "overview" ? " active" : ""}" data-action="nav" data-view="overview"><span class="name">Overview</span><span class="count${overviewCount ? "" : " zero"}">${overviewCount}</span></div>`,
        ...(state.agentReviewAvailable || agentComments().length ? [`<div class="nav-item${v.type === "agent-comments" ? " active" : ""}" data-action="nav" data-view="agent-comments"><span class="count" title="Agent findings in this scope, across all revisions; excludes replies and manual threads">${agentComments().length}</span><span class="name">Agent reviews</span></div>`] : []),
        `<div class="nav-item${v.type === "lessons" ? " active" : ""}" data-action="nav" data-view="lessons"><span class="name">Lessons learned</span><span class="muted">${r.lessons.length}</span></div>`,
        `<div class="section">Files (${files.length})</div>`,
    ];
    if (files.length) {
        html.push(
            `<div class="tree-controls"><button class="link" data-action="fold-tree" data-fold="1">Collapse all</button><button class="link" data-action="fold-tree" data-fold="0">Expand all</button></div>`,
            `<div role="tree">`,
        );
        treeHtml(buildTree(files), 0, html);
        html.push(`</div>`);
    } else if (state.snapshot) {
        html.push(`<div class="side-empty">${scopeOf(r) === "pending" ? "No uncommitted changes." : "No changes against the base."}</div>`);
    }
    requiredElement("#side").innerHTML = html.join("");
}

function renderMain(): void {
    const main = $("#main");
    if (!main) return;
    if (state.view.type === "file") {
        const file = displayFile(state.view.path);
        if (file) {
            main.innerHTML = fileView(file);
            return;
        }
        state.view = { type: "overview" };
    }
    if (state.view.type === "folder") {
        if (filesUnder(state.view.path).length) {
            main.innerHTML = folderView(state.view.path);
            return;
        }
        state.view = { type: "overview" };
    }
    main.innerHTML = state.view.type === "lessons" ? lessonsView() : state.view.type === "agent-comments" ? agentCommentsView() : overviewView();
}

type ComposerOptions = {
    label?: string;
    placeholder?: string;
    kind?: ThreadKind;
    path?: string;
    side?: DiffSide;
    startLine?: number;
    endLine?: number;
    alwaysOpen?: boolean;
    revisionId?: string;
};
const pinnedComposers = new Map<string, ComposerOptions>();
const composerContexts = new Map<string, ComposerOptions>();
const pinnedComposersKey = (reviewId: string) => `sr:${reviewId}:pinned-composers`;

function persistPinnedComposers(): void {
    if (!state.review) return;
    const key = pinnedComposersKey(state.review.reviewId);
    if (pinnedComposers.size) localStorage.setItem(key, JSON.stringify([...pinnedComposers]));
    else localStorage.removeItem(key);
}

function restorePinnedComposers(reviewId: string): void {
    pinnedComposers.clear();
    try {
        const value: unknown = JSON.parse(localStorage.getItem(pinnedComposersKey(reviewId)) ?? "[]");
        if (!Array.isArray(value)) throw new Error("Pinned composers must be an array.");
        for (const entry of value) {
            if (!Array.isArray(entry) || typeof entry[0] !== "string" || !isRecord(entry[1])) continue;
            const [key, options] = entry as [string, Record<string, unknown>];
            if ((options.kind !== "file" && options.kind !== "line" && options.kind !== "change")
                || typeof options.path !== "string" || typeof options.revisionId !== "string"
                || (options.side !== undefined && options.side !== "old" && options.side !== "new")
                || (options.startLine !== undefined && typeof options.startLine !== "number")
                || (options.endLine !== undefined && typeof options.endLine !== "number")
                || (options.label !== undefined && typeof options.label !== "string")
                || (options.placeholder !== undefined && typeof options.placeholder !== "string")) continue;
            pinnedComposers.set(key, {
                kind: options.kind, path: options.path, revisionId: options.revisionId, alwaysOpen: true,
                side: options.side, startLine: options.startLine, endLine: options.endLine,
                label: options.label, placeholder: options.placeholder,
            });
        }
    } catch {
        localStorage.removeItem(pinnedComposersKey(reviewId));
    }
}

function pinComposers(): void {
    const pin = (key: string, options: ComposerOptions): string | null => {
        if (pinnedComposers.has(key)) return null;
        const draft = getDraft(key);
        const pending = state.pending.get(key);
        state.open.delete(key);
        composerContexts.delete(key);
        if (!draft && !pending) return null;
        const pinnedKey = `pinned:${options.revisionId}:${key}`;
        pinnedComposers.set(pinnedKey, { ...options, alwaysOpen: true });
        setDraft(pinnedKey, draft);
        setDraft(key, "");
        if (pending) {
            state.pending.set(pinnedKey, pending);
            state.pending.delete(key);
        }
        return pinnedKey;
    };
    for (const box of Array.from(document.querySelectorAll<HTMLElement>(".composer[data-kind]"))) {
        const d = box.dataset;
        if (!d.key || (d.kind !== "line" && d.kind !== "change" && d.kind !== "file") || pinnedComposers.has(d.key)) continue;
        const textarea = box.querySelector<HTMLTextAreaElement>("textarea");
        if (textarea) setDraft(d.key, textarea.value);
        const pinnedKey = pin(d.key, {
            kind: d.kind, path: d.path, side: d.side === "old" ? "old" : "new",
            startLine: d.start ? Number(d.start) : undefined, endLine: d.end ? Number(d.end) : undefined, revisionId: d.revision,
            label: box.querySelector(".label")?.textContent ?? "Comment on original selection", alwaysOpen: true,
        });
        if (pinnedKey) {
            d.key = pinnedKey;
            if (textarea) textarea.dataset.composer = pinnedKey;
        }
    }
    for (const [key, options] of composerContexts) pin(key, options);
    // Row indices belong to the previous snapshot, never to the refreshed diff.
    state.selection = null;
    persistPinnedComposers();
}

function composerHtml(key: string, {
    label, placeholder, kind, path, side, startLine, endLine, alwaysOpen, revisionId,
}: ComposerOptions): string {
    const draft = getDraft(key);
    const p = state.pending.get(key);
    const open = alwaysOpen || state.open.has(key) || Boolean(draft) || Boolean(p);
    if (open && (kind === "line" || kind === "change" || kind === "file") && !pinnedComposers.has(key)) {
        composerContexts.set(key, { label, placeholder, kind, path, side, startLine, endLine, alwaysOpen: true, revisionId: revisionId ?? state.review?.currentRevisionId ?? undefined });
    }
    const data = [
        `data-key="${esc(key)}"`,
        `data-revision="${esc(revisionId ?? state.review?.currentRevisionId ?? "")}"`,
        kind ? `data-kind="${kind}"` : "",
        path ? `data-path="${esc(path)}"` : "",
        side ? `data-side="${side}"` : "",
        startLine ? `data-start="${startLine}"` : "",
        endLine ? `data-end="${endLine}"` : "",
    ].join(" ");
    const k = esc(key);
    const batching = deliveryMode() !== "immediate";
    const buttons = batching
        ? `<button data-action="submit" data-key="${k}" data-draft="0" title="Send this comment to Copilot right away"${p?.sending ? " disabled" : ""}>Send now</button>`
            + `<button class="primary" data-action="submit" data-key="${k}" data-draft="1" title="Hold this comment as a draft until you submit the review"${p?.sending ? " disabled>Saving…" : ">Add to review"}</button>`
        : `<button class="primary" data-action="submit" data-key="${k}" ${p?.sending ? "disabled" : ""}>${p?.sending ? "Sending…" : "Comment"}</button>`;
    return `<div class="composer${open ? " open" : ""}" ${data}>`
        + (label ? `<div class="label">${esc(label)}</div>` : "")
        + `<textarea data-composer="${k}" placeholder="${esc(placeholder ?? "Write a comment…")}" ${p?.sending ? "disabled" : ""}>${esc(draft)}</textarea>`
        + (p?.error ? `<div class="err">${esc(p.error)}</div>` : "")
        + `<div class="bar"><span class="hint">Markdown · Ctrl+Enter to ${batching ? "add to review" : "send"} · Esc to close</span>`
        + `<button data-action="cancel" data-key="${k}">Cancel</button>`
        + `${buttons}</div>`
        + `</div>`;
}

function deliveryHtml(m: ReviewMessage): string {
    const d = m.delivery;
    if (!d) return "";
    const resend = (label: string) => `<button class="link" data-action="retry" data-message="${esc(m.messageId)}">${label}</button>`;
    switch (d.state) {
        case "draft":
            return `<span class="delivery draft" title="Held until you submit the review">Draft · <button class="link" data-action="send-draft" data-message="${esc(m.messageId)}">Send now</button>`
                + ` · <button class="link" data-action="discard-draft" data-message="${esc(m.messageId)}">Discard</button></span>`;
        case "saving":
            return `<span class="delivery saving">Sending to Copilot…</span>`;
        case "queued": {
            const stale = state.busy === false && d.queuedAt && Date.now() - Date.parse(d.queuedAt) > STALE_QUEUE_MS;
            return `<span class="delivery queued">Queued for Copilot${stale ? ` · ${resend("Resend")}` : ""}</span>`;
        }
        case "processing":
            return `<span class="delivery processing">Copilot is working…</span>`;
        case "replied":
            return `<span class="delivery replied">✓ Replied</span>`;
        case "no-reply":
            return `<span class="delivery no-reply" title="Copilot finished without replying in this thread">No reply · ${resend("Resend")}</span>`;
        case "failed":
            return `<span class="delivery failed" title="${esc(d.error ?? "")}">Delivery failed · ${resend("Retry")}</span>`;
        default:
            return "";
    }
}

function messageHtml(m: ReviewMessage): string {
    const agent = m.author === "agent";
    const lessons = (m.lessonIds ?? []).map((id) => state.review?.lessons.find((l) => l.lessonId === id)).filter((lesson): lesson is Lesson => Boolean(lesson));
    return `<div class="msg" data-message-id="${esc(m.messageId)}">`
        + `<div class="msg-head"><span class="avatar${agent ? " agent" : ""}">${agent ? "AI" : "Me"}</span>`
        + `<span class="who">${agent ? "Copilot" : "You"}</span><span class="when" title="${esc(m.createdAt)}">${esc(ago(m.createdAt))}</span>`
        + (agent && m.outcome ? `<span class="outcome ${esc(m.outcome)}">${esc(m.outcome)}</span>` : "")
        + deliveryHtml(m)
        + `</div>${md(m.body)}`
        + (m.verification ? `<div class="verification">Verification: ${inline(m.verification)}</div>` : "")
        + (lessons.length ? `<div class="lessons">Guidelines:<ul>${lessons.map((l) => `<li><span class="badge">${esc(l.scope)}</span> ${lessonBadge(l)} ${inline(l.rule)}${l.savedTo ? ` <span class="muted mono">→ ${esc(l.savedTo)}</span>` : ""}</li>`).join("")}</ul></div>` : "")
        + `</div>`;
}

function findingApprovalIssue(finding: FindingReport): string {
    if (finding.assessment !== "confirmed") return "Only confirmed findings can be approved; discuss the assessment or run a fresh review.";
    if (!Object.hasOwn(FINDING_SEVERITIES, finding.severity) || finding.severity === "fyi") return "This finding is not an actionable suggestion; use Discuss.";
    const fields: Array<keyof FindingEvidence> = ["source", "baseline", "validation"];
    if (fields.some((key) => typeof finding.evidence?.[key] !== "string" || !finding.evidence[key]?.trim())) {
        return "Evidence is missing; run a fresh review or use Discuss.";
    }
    return "";
}

function findingEvidenceHtml(finding: FindingReport | null | undefined): string {
    if (!finding) return "";
    return `<details class="finding-evidence"><summary>Evidence and verification</summary><dl>`
        + ([["source", "Source / requirement"], ["baseline", "Baseline comparison"], ["validation", "Validation / limits"]] as const).map(([key, label]) =>
            `<dt>${label}</dt><dd>${typeof finding.evidence?.[key] === "string" ? md(finding.evidence[key]) : "Not recorded"}</dd>`).join("")
        + `</dl></details>`;
}

function threadHtml(t: ReviewThread, { showLocation = false }: { showLocation?: boolean } = {}): string {
    const loc: Partial<ThreadLocation> = t.location ?? {};
    const outdated = loc.state === "outdated";
    const defaultCollapsed = t.status !== "active" || outdated;
    const collapsed = state.collapsedThreads.has(t.threadId) || (defaultCollapsed && !state.expanded.has(t.threadId));
    const pending = t.messages.filter((m) => m.delivery && m.delivery.state !== "replied");
    const notInDiff = !outdated && !isPlaced(t);
    const anchor = t.anchor;
    const moved = anchor?.startLine != null && loc.startLine != null && (anchor.startLine !== loc.startLine || anchor.endLine !== loc.endLine);
    const options = STATUSES.map((s) => `<option value="${s}"${s === t.status ? " selected" : ""}>${s === "wontfix" ? "won't fix" : s}</option>`).join("");
    const head = `<div class="thread-head">`
        + `<span class="badge kind">${t.kind === "change" ? "change" : t.kind}</span>`
        + (t.agentReview ? `<span class="badge" title="Reported reviewer model">${esc(t.agentReview.model)} / ${esc(t.agentReview.category)}</span>` : "")
        + (t.agentReview ? `<span class="badge" title="Assessment reported by the coordinating agent">${esc(FINDING_ASSESSMENTS[t.agentReview.assessment] ?? "Unverified")}</span><span class="badge">${esc(FINDING_SEVERITIES[t.agentReview.severity] ?? "Severity not reported")}</span>` : "")
        + `<span class="loc">${showLocation ? `<button class="link" data-action="jump" data-thread="${esc(t.threadId)}">${esc(locLabel(t))}</button>` : esc(locLabel(t))}`
        + (moved && anchor ? ` <span class="muted" title="Line numbers changed since ${esc(anchor.revisionId)}">(originally ${esc(lineLabel(anchor))} in ${esc(anchor.revisionId)})</span>` : "")
        + `</span>`
        + (outdated ? `<span class="badge outdated" title="The commented code changed or was removed">Outdated</span>` : "")
        + (notInDiff ? `<span class="badge outdated" title="This location is not part of the current diff">Not in diff</span>` : "")
        + (t.status !== "active" ? `<span class="badge st-${t.status}">${t.status === "wontfix" ? "won't fix" : t.status}</span>` : "")
        + `<select data-action="status" data-thread="${esc(t.threadId)}" title="Thread status">${options}</select>`
        + (collapsed ? pending.map(deliveryHtml).join("") : "")
        + `<button class="link" data-action="toggle" data-thread="${esc(t.threadId)}" aria-expanded="${!collapsed}">${collapsed ? "Show" : "Hide"}</button>`
        + `</div>`;
    const original = outdated && t.anchor?.selectedLines?.length
        ? `<div class="original muted">Originally commented code (${esc(t.anchor.revisionId)}, ${esc(lineLabel(t.anchor))}):<pre>${esc(t.anchor.selectedLines.join("\n"))}</pre></div>`
        : "";
    const reply = composerHtml(`reply:${t.threadId}`, { placeholder: "Reply…" });
    const staleFinding = t.agentReview && t.agentReview.revisionId !== state.review?.currentRevisionId;
    const approvalIssue = t.agentReview ? findingApprovalIssue(t.agentReview) : "";
    const actions = t.agentReview
        ? `<div class="finding-actions"><button class="primary" data-action="approve-finding" data-thread="${esc(t.threadId)}" title="${esc(staleFinding ? "Review changed; rerun before approving" : approvalIssue || "Send this suggestion to the coding agent for implementation")}"${t.agentReview.approvalMessageId || staleFinding || approvalIssue || t.status !== "active" || state.approving.has(t.threadId) ? " disabled" : ""}>${t.agentReview.approvalMessageId ? "Approved" : "Approve"}</button>`
            + `<button data-action="discuss-finding" data-thread="${esc(t.threadId)}">Discuss</button></div>`
        : "";
    return `<div class="thread${collapsed ? " collapsed" : ""}" data-thread-id="${esc(t.threadId)}">${head}<div class="thread-body">${original}${t.messages.map((m, i) => messageHtml(m) + (i === 0 ? findingEvidenceHtml(t.agentReview) : "")).join("")}${actions}${reply}</div></div>`;
}

// Explains an empty diff and, for pending changes, offers the way back to the full branch diff.
function emptyDiffHtml(): string {
    const files = state.snapshot?.files;
    if (!files || files.length) return "";
    if (scopeOf(state.review) === "pending") {
        return `<div class="card empty-diff"><strong>No uncommitted changes.</strong> The working tree matches HEAD, so there is nothing to review in this scope.`
            + ` <button data-action="scope" data-scope="all">Switch to All changes</button></div>`;
    }
    return `<div class="card empty-diff"><strong>No changes to review.</strong> Nothing differs from ${esc(state.review?.base)}.</div>`;
}

function overviewView(): string {
    const r = state.review;
    if (!r) return "";
    const overall = r.threads.filter((t) => t.kind === "overview" && t.status === "active");
    const unplaced = r.threads.filter((t) => t.kind !== "overview" && t.status === "active" && !isPlaced(t));
    const others = r.threads.filter((t) => t.kind !== "overview");
    const active = others.filter((t) => t.status === "active");
    const done = r.threads.filter((t) => t.status !== "active");
    const listRow = (t: ReviewThread) => {
        const last = t.messages[t.messages.length - 1];
        const lastUser = [...t.messages].reverse().find((m) => m.author === "user");
        return `<div class="list-row"><span class="badge kind">${t.kind}</span>`
            + `<button class="link loc" data-action="jump" data-thread="${esc(t.threadId)}">${esc(locLabel(t))}</button>`
            + `<span class="snippet">${esc(last.author === "agent" ? "Copilot: " : "")}${esc(last.body.replace(/\s+/g, " ").slice(0, 160))}</span>`
            + (lastUser ? deliveryHtml(lastUser) : "")
            + `</div>`;
    };
    return emptyDiffHtml()
        + descriptionHtml()
        + `<h2>Overall discussion</h2>`
        + (overall.length ? overall.map((t) => threadHtml(t)).join("") : `<div class="empty">No overall comments yet.</div>`)
        + `<div class="thread">${composerHtml("overview:new", { kind: "overview", label: "Discuss the change or request description edits", placeholder: "Ask to revise the description, discuss the design, or request a change…", alwaysOpen: true })}</div>`
        + (unplaced.length ? `<h2>Comments outside the current diff (${unplaced.length})</h2>${unplaced.map((t) => threadHtml(t, { showLocation: true })).join("")}` : "")
        + `<h2>Active threads (${active.length})</h2><div class="card">${active.length ? active.map(listRow).join("") : `<div class="empty">No active threads. Select lines in a file to comment.</div>`}</div>`
        + (done.length ? `<h2>Closed threads (${done.length})</h2>${done.map((t) => threadHtml(t, { showLocation: true })).join("")}` : "");
}

function lessonsEmptyHint(): string {
    if (!state.settings) return "Copilot records reusable rules here when your comments reveal a preference.";
    switch (learningMode()) {
        case "suggest":
            return "Copilot proposes reusable guidelines here when your comments reveal a preference, and saves one after you approve it.";
        case "auto":
            return "Copilot saves reusable guidelines here when your comments reveal a preference.";
        default:
            return "Learning is off for this repository, so Copilot does not record guidelines from your comments. Use Configure to turn it on.";
    }
}

function lessonsView(): string {
    const lessons = state.review?.lessons ?? [];
    if (!lessons.length) return `<h2>Lessons learned</h2><div class="empty">${lessonsEmptyHint()}</div>`;
    const rows = [...lessons].reverse().map((l) => `<tr><td><span class="badge">${esc(l.scope)}</span></td><td>${lessonBadge(l)}</td><td>${inline(l.rule)}</td><td class="mono muted">${esc(l.savedTo ?? "")}</td><td><button class="link" data-action="jump" data-thread="${esc(l.threadId)}">thread</button><div class="muted">${esc(ago(l.createdAt))}</div></td></tr>`).join("");
    return `<h2>Lessons learned (${lessons.length})</h2><table class="lessons-table"><thead><tr><th>Scope</th><th>Status</th><th>Rule</th><th>Saved to</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function fileView(file: DiffFile, { stacked = false, folded = false }: { stacked?: boolean; folded?: boolean } = {}): string {
    const threads = (state.review?.threads ?? []).filter((t) => t.kind !== "overview" && t.location?.path === file.path);
    const placed = new Map<string, ReviewThread[]>();
    const unplaced: ReviewThread[] = [];
    for (const t of threads) {
        const p = placeThread(t, file);
        if (!p) {
            unplaced.push(t);
            continue;
        }
        const key = p.where === "file" ? "file" : p.where === "hunk" ? `h${p.hunk}` : `r${p.hunk}:${p.row}`;
        if (!placed.has(key)) placed.set(key, []);
        placed.get(key)?.push(t);
    }
    const highlighted = new Set();
    for (const t of threads) {
        if (t.kind !== "line" || t.status !== "active" || !t.location || t.location.state === "outdated"
            || t.location.startLine === undefined || t.location.endLine === undefined) continue;
        for (let n = t.location.startLine; n <= t.location.endLine; n++) highlighted.add(`${t.location.side}:${n}`);
    }

    const letter = STATUS_LETTER[file.status] ?? "M";
    const fileKey = `file:${file.path}`;
    const activeHere = threads.filter((t) => t.status === "active").length;
    const pathHtml = stacked
        ? `<button class="link path-link" data-action="nav" data-view="file" data-path="${esc(file.path)}" title="Open only this file">${esc(file.path)}</button>`
        : esc(file.path);
    const html = [`<section class="file-section" data-file="${esc(file.path)}">`,
        `<div class="file-head${stacked ? " stacked" : ""}">`
        + (stacked ? `<span class="twisty${folded ? "" : " open"}" data-action="fold-file" data-path="${esc(file.path)}" title="${folded ? "Show diff" : "Hide diff"}">${CHEVRON}</span>` : "")
        + `<span class="status-letter ${letter}">${letter}</span><span class="path">${pathHtml}${file.oldPath && file.oldPath !== file.path ? ` <span class="muted">(from ${esc(file.oldPath)})</span>` : ""}${file.untracked ? ` <span class="badge">untracked</span>` : ""}</span>`
        + (stacked && folded && activeHere ? `<span class="count">${activeHere}</span>` : "")
        + `<span class="stat"><span class="add">+${file.additions}</span> <span class="del">−${file.deletions}</span></span>`
        + `<button data-action="open" data-key="${esc(fileKey)}" data-path="${esc(file.path)}">Comment on file</button></div>`];
    if (folded) {
        html.push(`</section>`);
        return html.join("");
    }
    html.push((placed.get("file") ?? []).map((t) => threadHtml(t)).join(""));
    if (file.oldMode !== file.newMode && (file.oldMode || file.newMode)) {
        html.push(`<div class="card muted">File mode: ${esc(file.oldMode ?? "(absent)")} to ${esc(file.newMode ?? "(absent)")}${file.typeChanged ? " (file type changed)" : ""}</div>`);
    }
    if (state.open.has(fileKey) || getDraft(fileKey) || state.pending.has(fileKey)) {
        html.push(`<div class="thread">${composerHtml(fileKey, { kind: "file", path: file.path, label: `Comment on ${file.path}`, alwaysOpen: true })}</div>`);
    }
    if (file.binary) html.push(`<div class="card muted">${esc(file.note ?? "Binary file not shown.")}</div>`);
    if (!file.binary && !file.hunks.length) html.push(`<div class="card muted">No textual changes (mode or rename only).</div>`);
    if (!stacked && !file.full && needsContent(file)) {
        const entry = contentEntry(file);
        const why = entry.status === "unavailable"
            ? ({ stale: "the working tree changed since this revision; Refresh to see the full file", "too-large": "the file is too large", missing: "the file is missing from the working tree", "base-unavailable": "the base revision cannot be read" } as Record<string, string>)[entry.reason ?? ""] ?? entry.reason
            : "";
        const note = entry.status === "loading" ? "Loading full file…"
            : entry.status === "ready" ? "Showing changes only until the current line selection is closed."
            : `Showing changes only: ${esc(why)}.`;
        html.push(`<div class="muted full-note">${note}</div>`);
    }

    const sel = state.selection?.path === file.path ? state.selection : null;
    const selRange = sel ? selectionRange(file, sel) : null;
    const syntax = highlightFile(file);
    html.push(`<div class="diff${file.full ? " full" : ""}">`);
    file.hunks.forEach((hunk: DiffHunk, h: number) => {
        const range = hunk.gap ? null : hunkAnchorRange(hunk);
        const changeKey = range ? `change:${file.path}:${range.side}:${range.startLine}-${range.endLine}` : null;
        if (!hunk.gap) {
            html.push(file.full
                ? `<div class="hunk-head change-bar"><span class="h muted">Change ${esc(lineLabel(range ?? {}))}</span>${range ? `<button data-action="open" data-key="${esc(changeKey)}">Discuss this change</button>` : ""}</div>`
                : `<div class="hunk-head"><span class="h" title="${esc(hunk.header)}">${esc(hunk.header)}</span>${range ? `<button data-action="open" data-key="${esc(changeKey)}">Discuss this change</button>` : ""}</div>`);
        }
        const hunkThreads = placed.get(`h${h}`) ?? [];
        const showChangeComposer = Boolean(range && changeKey && (state.open.has(changeKey) || getDraft(changeKey) || state.pending.has(changeKey)));
        if (hunkThreads.length || showChangeComposer) {
            html.push(`<div class="hunk-threads">${hunkThreads.map((t) => threadHtml(t)).join("")}`
                + (showChangeComposer && range && changeKey ? `<div class="thread">${composerHtml(changeKey, { kind: "change", path: file.path, side: range.side, startLine: range.startLine, endLine: range.endLine, label: `Discuss this change (${range.side === "old" ? "old " : ""}${lineLabel(range)})`, alwaysOpen: true })}</div>` : "")
                + `</div>`);
        }
        html.push(`<table class="rows"><colgroup><col style="width:52px"><col style="width:52px"><col style="width:22px"><col></colgroup><tbody>`);
        hunk.rows.forEach((row: DiffRow, i: number) => {
            const selected = sel && sel.hunk === h && i >= sel.from && i <= sel.to;
            const hl = (row.n != null && highlighted.has(`new:${row.n}`)) || (row.t === "del" && highlighted.has(`old:${row.o}`));
            const prefix = row.t === "add" ? "+" : row.t === "del" ? "-" : " ";
            html.push(`<tr class="row ${row.t}${selected ? " sel" : ""}${hl ? " hl" : ""}" data-h="${h}" data-i="${i}">`
                + `<td class="ln">${row.o ?? ""}</td><td class="ln">${row.n ?? ""}</td><td class="gut"><span>+</span></td>`
                + `<td class="code" data-p="${prefix}">${syntax[h][i]}</td></tr>`);
            if (row.noNewlineAtEnd) {
                const side = row.t === "del" ? "old side" : row.t === "add" ? "new side" : "both sides";
                html.push(`<tr class="eof-note"><td colspan="3"></td><td>\\ No newline at end of file (${side})</td></tr>`);
            }
            const rowThreads = placed.get(`r${h}:${i}`) ?? [];
            const composerHere = Boolean(sel && selRange && !state.dragging && sel.hunk === h && sel.to === i);
            if (rowThreads.length || (composerHere && selRange)) {
                const lineKey = composerHere && selRange ? `line:${file.path}:${selRange.side}:${selRange.startLine}-${selRange.endLine}` : "";
                html.push(`<tr class="inline"><td colspan="4">${rowThreads.map((t) => threadHtml(t)).join("")}`
                    + (composerHere && selRange ? `<div class="thread">${composerHtml(lineKey, { kind: "line", path: file.path, side: selRange.side, startLine: selRange.startLine, endLine: selRange.endLine, label: `Comment on ${selRange.side === "old" ? "old " : ""}${lineLabel(selRange)}`, alwaysOpen: true })}</div>` : "")
                    + `</td></tr>`);
            }
        });
        html.push(`</tbody></table>`);
    });
    html.push(`</div>`);
    if (unplaced.length) {
        html.push(`<h2>Comments outside the current diff (${unplaced.length})</h2>${unplaced.map((t) => threadHtml(t)).join("")}`);
    }
    html.push(`</section>`);
    return html.join("");
}

// Folder selection shows every changed file under it, stacked, like ADO's Files tab.
// Past a row budget, files start folded so huge folders stay responsive.
function folderView(dir: string): string {
    const files = filesUnder(dir);
    const adds = files.reduce((s, f) => s + f.additions, 0);
    const dels = files.reduce((s, f) => s + f.deletions, 0);
    const html = [`<div class="folder-head">${FOLDER_ICON}<span class="path">${esc(dir === "" ? repoName() : dir)}</span>`
        + `<span class="muted">${files.length} file${files.length === 1 ? "" : "s"}</span>`
        + `<span class="stat"><span class="add">+${adds}</span> <span class="del">−${dels}</span></span>`
        + `<span class="spacer"></span><button class="link" data-action="fold-all" data-fold="1">Collapse all</button><button class="link" data-action="fold-all" data-fold="0">Expand all</button></div>`];
    let rows = 0;
    for (const f of files) {
        const size = f.hunks.reduce((s, h) => s + h.rows.length, 0);
        const folded = state.fileFold.has(f.path) ? state.fileFold.get(f.path) : rows + size > FOLDER_VIEW_ROW_BUDGET && rows > 0;
        if (!folded) rows += size;
        html.push(fileView(f, { stacked: true, folded }));
    }
    return html.join("");
}

// ---------- Actions ----------

let toastTimer: number | undefined;
function toast(text: string, error = false): void {
    const el = $("#toast");
    if (!el) return;
    el.textContent = text;
    el.className = error ? "error" : "";
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
        el.hidden = true;
    }, error ? 6000 : 2500);
}

function navigate(view: View): void {
    state.view = view;
    state.selection = null;
    state.pendingJump = null;
    if (view.type === "file" || view.type === "folder") expandAncestors(view.path);
    saveView();
    render();
    const main = $("#main");
    if (main) main.scrollTop = 0;
}

function focusComposer(key: string): void {
    const el = document.querySelector<HTMLTextAreaElement>(`textarea[data-composer="${CSS.escape(key)}"]`);
    if (el) {
        el.focus();
        el.scrollIntoView({ block: "nearest" });
    }
}

function jumpToThread(threadId: string): void {
    const review = state.review;
    if (!review) return;
    const t = review.threads.find((x) => x.threadId === threadId);
    if (!t) return;
    state.collapsedThreads.delete(threadId);
    if (t.status !== "active" || t.location?.state === "outdated") state.expanded.add(threadId);
    const path = t.location?.path;
    const inFile = t.kind !== "overview" && isPlaced(t) && fileOf(path);
    const unplacedInFile = t.kind !== "overview" && !isPlaced(t) && fileOf(t.location?.path);
    if ((inFile || unplacedInFile) && path && state.view.type === "folder" && inDir(path, state.view.path)) {
        state.fileFold.set(path, false);
        render();
    } else {
        navigate((inFile || unplacedInFile) && path ? { type: "file", path } : { type: "overview" });
    }
    state.pendingJump = threadId;
    revealPendingJump();
}

// Scrolls to a jumped-to thread; retried after the full file loads, since it may move or appear then.
function revealPendingJump(): void {
    const threadId = state.pendingJump;
    if (!threadId) return;
    const el = document.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(threadId)}"]`);
    if (el) {
        el.scrollIntoView({ block: "center" });
        el.classList.add("flash");
        setTimeout(() => el.classList.remove("flash"), 1600);
    }
    const loading = state.view.type === "file" && [...state.content.values()].some((e) => e.status === "loading");
    if (!loading) state.pendingJump = null;
}

function closeComposer(key: string, discard: boolean): void {
    pinnedComposers.delete(key);
    composerContexts.delete(key);
    if (discard) setDraft(key, "");
    state.open.delete(key);
    state.pending.delete(key);
    persistPinnedComposers();
    if (key.startsWith("line:")) state.selection = null;
    if (document.activeElement instanceof HTMLElement && document.activeElement.dataset.composer === key) document.activeElement.blur();
    render();
}

// The composer's default action: undefined lets the server apply the delivery mode; otherwise the comment is held as a draft.
function defaultDraft(): boolean | undefined {
    return deliveryMode() === "immediate" ? undefined : true;
}

async function submit(key: string, draft: boolean | undefined = defaultDraft()): Promise<void> {
    const review = state.review;
    if (!review) return;
    const box = document.querySelector<HTMLElement>(`.composer[data-key="${CSS.escape(key)}"]`);
    const textarea = box?.querySelector<HTMLTextAreaElement>("textarea");
    if (!box || !textarea) return;
    const body = textarea.value.trim();
    if (!body) {
        textarea.focus();
        return;
    }
    setDraft(key, textarea.value);
    const pending = state.pending.get(key) ?? { clientRequestId: uuid() };
    pending.sending = true;
    pending.error = null;
    state.pending.set(key, pending);
    const submittedKey = () => [...state.pending].find(([, entry]) => entry === pending)?.[0] ?? key;
    render();
    try {
        let res: unknown;
        const hold = draft === undefined ? {} : { draft };
        if (key.startsWith("reply:")) {
            res = await api("POST", `threads/${encodeURIComponent(key.slice(6))}/messages`, { body, clientRequestId: pending.clientRequestId, descriptionVersion: review.description?.version ?? 0, ...hold });
        } else {
            const d = box.dataset;
            res = await api("POST", "threads", {
                kind: d.kind,
                path: d.path,
                side: d.side,
                startLine: d.start ? Number(d.start) : undefined,
                endLine: d.end ? Number(d.end) : undefined,
                revisionId: d.revision || review.currentRevisionId,
                descriptionVersion: review.description?.version ?? 0,
                body,
                clientRequestId: pending.clientRequestId,
                ...hold,
            });
        }
        const sentKey = submittedKey();
        setDraft(sentKey, "");
        pinnedComposers.delete(sentKey);
        composerContexts.delete(sentKey);
        state.pending.delete(sentKey);
        state.open.delete(sentKey);
        persistPinnedComposers();
        if (sentKey.startsWith("line:")) state.selection = null;
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        await loadState();
        if (isRecord(res) && typeof res.threadId === "string" && !key.startsWith("reply:")) {
            const el = document.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(res.threadId)}"]`);
            el?.classList.add("flash");
            setTimeout(() => el?.classList.remove("flash"), 1600);
        }
    } catch (err: unknown) {
        pending.sending = false;
        pending.error = errorMessage(err);
        render();
    }
}

function dataValue(element: HTMLElement, name: string): string {
    return element.dataset[name] ?? "";
}

async function onClick(e: MouseEvent): Promise<void> {
    if (!(e.target instanceof Element)) return;
    const target = e.target.closest<HTMLElement>("[data-action]");
    if (!target || target instanceof HTMLSelectElement) return;
    const value = (name: string) => dataValue(target, name);
    const action = value("action");
    try {
        switch (action) {
            case "agent-review":
                await runAgentReview();
                break;
            case "agent-review-configure":
                openAgentReview("agent-review-configure");
                break;
            case "agent-review-save-defaults":
                await startAgentReview(true);
                break;
            case "agent-review-apply-skills":
                applyReviewSkills();
                break;
            case "agent-review-start":
                await startAgentReview();
                break;
            case "agent-review-close":
                await api("POST", `agent-reviews/${encodeURIComponent(value("run"))}/close`, {});
                await loadState();
                break;
            case "discuss-finding":
                state.collapsedThreads.delete(value("thread"));
                state.expanded.add(value("thread"));
                state.open.add(`reply:${value("thread")}`);
                render();
                focusComposer(`reply:${value("thread")}`);
                break;
            case "approve-finding": {
                const id = value("thread");
                const review = state.review;
                if (!review || !id) break;
                if (state.approving.has(id)) break;
                state.approving.add(id);
                render();
                try {
                    const res = await api("POST", `threads/${encodeURIComponent(id)}/approve`, { revisionId: review.currentRevisionId });
                    const message = isRecord(res) && typeof res.error === "string" ? res.error : null;
                    toast(message ? `Approved, but delivery failed: ${message}. Retry in the thread.` : "Approved and sent to the coding agent", Boolean(message));
                } finally {
                    state.approving.delete(id);
                    await loadState();
                }
                break;
            }
            case "discuss-description":
                focusComposer("overview:new");
                break;
            case "nav": {
                const view = value("view");
                const path = value("path");
                if (view === "folder" && state.view.type === "folder" && state.view.path === path) {
                    setDirCollapsed(path, !collapsedDirs().has(path));
                    render();
                } else {
                    if (view === "file" || view === "folder") navigate({ type: view, path });
                    else if (view === "overview" || view === "lessons" || view === "agent-comments") navigate({ type: view });
                }
                break;
            }
            case "fold":
                setDirCollapsed(value("path"), !collapsedDirs().has(value("path")));
                render();
                break;
            case "fold-tree":
                setAllDirsCollapsed(value("fold") === "1");
                render();
                break;
            case "fold-file": {
                const path = value("path");
                state.fileFold.set(path, target.classList.contains("open"));
                render();
                document.querySelector<HTMLElement>(`.file-section[data-file="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "nearest" });
                break;
            }
            case "fold-all":
                for (const f of filesUnder(state.view.type === "folder" ? state.view.path : "")) state.fileFold.set(f.path, value("fold") === "1");
                render();
                break;
            case "refresh":
                target.setAttribute("disabled", "");
                await api("POST", "refresh", {});
                await loadState();
                toast("Refreshed from the working tree");
                break;
            case "open":
                if (value("path")) state.fileFold.set(value("path"), false);
                state.open.add(value("key"));
                render();
                focusComposer(value("key"));
                break;
            case "cancel":
                closeComposer(value("key"), true);
                break;
            case "submit": {
                const flag = value("draft");
                await submit(value("key"), flag === "1" ? true : flag === "0" ? false : defaultDraft());
                break;
            }
            case "retry":
                await api("POST", `messages/${encodeURIComponent(value("message"))}/retry`, {});
                await loadState();
                toast("Sent to Copilot again");
                break;
            case "send-draft": {
                const res = await api("POST", `messages/${encodeURIComponent(value("message"))}/send`, {});
                await loadState();
                const message = isRecord(res) && typeof res.error === "string" ? res.error : null;
                toast(message ?? "Sent to Copilot", Boolean(message));
                break;
            }
            case "discard-draft":
                await api("POST", `messages/${encodeURIComponent(value("message"))}/discard`, {});
                await loadState();
                toast("Draft discarded");
                break;
            case "submit-review": {
                if (state.submitting) break;
                state.submitting = true;
                renderTop();
                try {
                    const res = await api("POST", "submit", {});
                    const submitted = isRecord(res) && typeof res.submitted === "number" ? res.submitted : 0;
                    const error = isRecord(res) && typeof res.error === "string" ? res.error : null;
                    if (error) toast(error, true);
                    else toast(`Sent ${submitted} ${submitted === 1 ? "comment" : "comments"} to Copilot`);
                } finally {
                    state.submitting = false;
                    await loadState();
                }
                break;
            }
            case "delivery-choose": {
                const mode = value("mode");
                if (mode !== "immediate" && mode !== "batch") break;
                const res = await api("POST", "delivery", { mode });
                await loadState();
                const submitted = isRecord(res) && typeof res.submitted === "number" ? res.submitted : 0;
                const error = isRecord(res) && typeof res.error === "string" ? res.error : null;
                const drafts = `${submitted} waiting ${submitted === 1 ? "draft" : "drafts"}`;
                if (error) toast(`Sending each comment now, but ${drafts} could not be sent: ${error}`, true);
                else toast(mode === "immediate"
                    ? (submitted ? `Sending each comment now. Sent ${drafts}.` : "Sending each comment now")
                    : "Batching comments. Submit the review when you are done.");
                break;
            }
            case "delivery-reask":
                await api("POST", "delivery", { mode: null });
                await loadState();
                break;
            case "toggle": {
                const id = value("thread");
                const thread = state.review?.threads.find((t) => t.threadId === id);
                if (!thread) break;
                const outdated = thread.location?.state === "outdated";
                const defaultCollapsed = thread.status !== "active" || outdated;
                const collapsed = state.collapsedThreads.has(id) || (defaultCollapsed && !state.expanded.has(id));
                if (collapsed) {
                    state.collapsedThreads.delete(id);
                    state.expanded.add(id);
                } else {
                    state.expanded.delete(id);
                    if (!defaultCollapsed) state.collapsedThreads.add(id);
                }
                render();
                break;
            }
            case "jump":
                jumpToThread(value("thread"));
                break;
            case "scope":
                {
                    const scope = value("scope");
                    if (scope === "all" || scope === "pending") await switchScope(scope);
                }
                break;
            case "review-skills-refresh":
                await refreshReviewSkills();
                break;
            case "review-tab":
                if (state.dialog?.type === "agent-review" && state.dialog.tab !== value("tab")) {
                    state.dialog.tab = value("tab") === "skills" ? "skills" : "general";
                    renderDialog();
                    focusIn(`#dialog [data-action="review-tab"][data-tab="${state.dialog.tab}"]`);
                }
                break;
            case "configure":
                openConfigure();
                break;
            case "dialog-cancel":
                closeConfigure();
                break;
            case "dialog-backdrop":
                if (e.target === target) closeConfigure();
                break;
            case "dialog-save":
                await saveConfigure();
                break;
            case "learning-set":
                {
                    const mode = value("mode");
                    if (isLearningMode(mode)) await updateSettings({ learning: mode });
                }
                toast(`Learning mode: ${LEARNING[learningMode()].label}`);
                break;
            case "learning-dismiss":
                await updateSettings({ dismissed: true });
                break;
            default:
                break;
        }
    } catch (err: unknown) {
        toast(errorMessage(err), true);
        if (action === "refresh") target.removeAttribute("disabled");
    }
}

async function onChange(e: Event): Promise<void> {
    const el = e.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) return;
    if (el instanceof HTMLInputElement && el.name === "review-skill-defaults" && state.dialog?.type === "agent-review") {
        state.dialog.saveSkillDefaults = el.checked;
        renderDialog();
        focusIn(`#dialog input[name="${el.name}"]`);
        return;
    }
    if (el instanceof HTMLInputElement && el.name === "review-skill" && state.dialog?.type === "agent-review") {
        const names = new Set(state.dialog.skillNames ?? []);
        if (el.checked) names.add(el.value);
        else names.delete(el.value);
        state.dialog.skillNames = (state.dialog.skillCatalog?.skills.map((skill) => skill.name) ?? [...names]).filter((name) => names.has(name));
        return;
    }
    if (el instanceof HTMLInputElement && (el.name === "review-save-defaults" || el.name === "review-skip-dialog") && state.dialog?.type === "agent-review") {
        state.dialog[el.name === "review-save-defaults" ? "saveDefaults" : "skipDialog"] = el.checked;
        renderDialog();
        focusIn(`#dialog input[name="${el.name}"]`);
        return;
    }
    if (el.name === "review-focus" && state.dialog?.type === "agent-review") {
    if (isReviewFocus(el.value)) state.dialog.focus = el.value;
        return;
    }
    if ((el.name === "learning" || el.name === "delivery") && state.dialog?.type === "configure") {
        if (el.name === "learning" && (el.value === "off" || el.value === "suggest" || el.value === "auto")) state.dialog.learning = el.value;
        if (el.name === "delivery" && (el.value === "immediate" || el.value === "batch" || el.value === "ask")) state.dialog.delivery = el.value;
        return;
    }
    if (el.dataset?.action !== "status") return;
    const threadId = el.dataset.thread;
    if (!threadId || !isThreadStatus(el.value)) return;
    try {
        await api("POST", `threads/${encodeURIComponent(threadId)}/status`, { status: el.value });
        if (el.value !== "active") state.expanded.delete(threadId);
        await loadState();
    } catch (err: unknown) {
        toast(errorMessage(err), true);
        await loadState().catch(() => undefined);
    }
}

function onInput(e: Event): void {
    const el = e.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
    if ((el.name === "review-models" || el.name === "review-intent") && state.dialog?.type === "agent-review") {
        state.dialog[el.name === "review-models" ? "models" : "intent"] = el.value;
        return;
    }
    if (el.dataset?.composer) {
        setDraft(el.dataset.composer, el.value);
        el.closest(".composer")?.classList.add("open");
    }
}

function onKeyDown(e: KeyboardEvent): void {
    if (state.dialog) {
        if (e.key === "Escape") {
            e.preventDefault();
            closeConfigure();
        } else if (e.key === "Tab") trapTab(e);
        return;
    }
    const el = e.target;
    if (!(el instanceof HTMLTextAreaElement)) return;
    const key = el.dataset.composer;
    if (!key) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submit(key);
    } else if (e.key === "Escape") {
        e.preventDefault();
        if (key.startsWith("reply:") && !el.value.trim()) {
            el.closest(".composer")?.classList.remove("open");
            el.blur();
        } else if (!el.value.trim()) closeComposer(key, true);
        else el.blur();
    }
}

function onFocusIn(e: FocusEvent): void {
    const el = e.target;
    if (el instanceof HTMLTextAreaElement && el.dataset.composer) el.closest(".composer")?.classList.add("open");
}

function onFocusOut(e: FocusEvent): void {
    const el = e.target;
    if (!(el instanceof HTMLTextAreaElement)) return;
    const key = el.dataset?.composer;
    if (!key || !key.startsWith("reply:")) return;
    setTimeout(() => {
        const box = el.closest(".composer");
        if (box && !el.value.trim() && !box.contains(document.activeElement)) box.classList.remove("open");
    }, 150);
}

// ---------- Overview ruler (change markers beside the scrollbar) ----------

// Merges adjacent rows of the same kind so a long change becomes one marker, not one per line.
type RulerItem = { kind: "thread" | "add" | "del"; top: number; height: number };
function rulerMarks(items: RulerItem[], scrollHeight: number, minPx = 3): Array<{ kind: RulerItem["kind"]; top: number; topPct: number; heightPct: number; minPx: number }> {
    const marks: Array<{ kind: RulerItem["kind"]; top: number; bottom: number }> = [];
    for (const it of items) {
        const last = marks[marks.length - 1];
        if (last && last.kind === it.kind && it.top <= last.bottom + 1) {
            last.bottom = Math.max(last.bottom, it.top + it.height);
            continue;
        }
        marks.push({ kind: it.kind, top: it.top, bottom: it.top + it.height });
    }
    return marks.map((m) => ({
        kind: m.kind,
        top: m.top,
        topPct: (m.top / scrollHeight) * 100,
        heightPct: (Math.max(m.bottom - m.top, 0) / scrollHeight) * 100,
        minPx,
    }));
}

function renderRuler(): void {
    const main = $("#main");
    const ruler = $("#ruler");
    if (!main || !ruler) return;
    const mainRect = main.getBoundingClientRect();
    ruler.style.right = `${main.offsetWidth - main.clientWidth}px`;
    const offset = main.scrollTop - mainRect.top;
    const items: RulerItem[] = [];
    for (const el of Array.from(main.querySelectorAll<HTMLTableRowElement>("tr.row.add, tr.row.del, tr.inline"))) {
        const r = el.getBoundingClientRect();
        if (!r.height) continue;
        const kind = el.classList.contains("inline") ? "thread" : el.classList.contains("add") ? "add" : "del";
        items.push({ kind, top: r.top + offset, height: r.height });
    }
    const scrollable = main.scrollHeight > main.clientHeight;
    ruler.hidden = !scrollable || items.length === 0;
    if (ruler.hidden) {
        ruler.innerHTML = "";
        return;
    }
    ruler.innerHTML = rulerMarks(items, main.scrollHeight)
        .map((m) => `<div class="mark ${m.kind}" data-top="${m.top}" style="top:${m.topPct}%;height:max(${m.minPx}px, ${m.heightPct}%)"></div>`)
        .join("")
        + `<div class="viewport"></div>`;
    paintRulerViewport();
}

function paintRulerViewport(): void {
    const main = $("#main");
    const vp = $("#ruler .viewport");
    if (!main || !vp) return;
    vp.style.top = `${(main.scrollTop / main.scrollHeight) * 100}%`;
    vp.style.height = `${(main.clientHeight / main.scrollHeight) * 100}%`;
}

function onRulerClick(e: MouseEvent): void {
    const main = $("#main");
    const ruler = $("#ruler");
    if (!main || !ruler || !(e.target instanceof Element)) return;
    const mark = e.target.closest<HTMLElement>(".mark");
    const target = mark
        ? Number(mark.dataset.top)
        : ((e.clientY - ruler.getBoundingClientRect().top) / ruler.clientHeight) * main.scrollHeight;
    main.scrollTo({ top: Math.max(0, target - main.clientHeight / 3), behavior: "smooth" });
}

// ---------- Line selection (click / shift-click / drag on line numbers or "+") ----------

function rowFromEvent(e: MouseEvent): RowPosition | null {
    if (!(e.target instanceof Element)) return null;
    const tr = e.target.closest<HTMLTableRowElement>("tr.row");
    const path = tr?.closest<HTMLElement>("[data-file]")?.dataset.file;
    if (!tr || !path) return null;
    return { path, h: Number(tr.dataset.h), i: Number(tr.dataset.i), full: Boolean(tr.closest(".diff")?.classList.contains("full")) };
}

function paintSelection(): void {
    const sel = state.selection;
    for (const tr of Array.from(document.querySelectorAll<HTMLTableRowElement>("tr.row"))) {
        const on = sel && tr.closest<HTMLElement>("[data-file]")?.dataset.file === sel.path && Number(tr.dataset.h) === sel.hunk && Number(tr.dataset.i) >= sel.from && Number(tr.dataset.i) <= sel.to;
        tr.classList.toggle("sel", Boolean(on));
    }
}

function onMouseDown(e: MouseEvent): void {
    if (e.button !== 0 || !(e.target instanceof Element) || !e.target.closest("td.ln, td.gut")) return;
    const pos = rowFromEvent(e);
    if (!pos) return;
    e.preventDefault();
    const { path } = pos;
    const sel = state.selection;
    if (e.shiftKey && sel && sel.path === path && sel.hunk === pos.h && sel.full === pos.full) {
        sel.from = Math.min(sel.anchor, pos.i);
        sel.to = Math.max(sel.anchor, pos.i);
    } else {
        state.selection = { path, hunk: pos.h, anchor: pos.i, from: pos.i, to: pos.i, full: pos.full };
    }
    state.dragging = true;
    paintSelection();
}

function onMouseOver(e: MouseEvent): void {
    if (!state.dragging) return;
    const pos = rowFromEvent(e);
    const sel = state.selection;
    if (!pos || !sel || pos.path !== sel.path || pos.h !== sel.hunk) return;
    sel.from = Math.min(sel.anchor, pos.i);
    sel.to = Math.max(sel.anchor, pos.i);
    paintSelection();
}

function onMouseUp(): void {
    if (!state.dragging) return;
    state.dragging = false;
    const selection = state.selection;
    if (!selection) return;
    const file = displayFile(selection.path);
    if (!file) return;
    const r = selectionRange(file, selection);
    render();
    focusComposer(`line:${file.path}:${r.side}:${r.startLine}-${r.endLine}`);
}

// ---------- Boot ----------

document.addEventListener("click", onClick);
document.addEventListener("change", onChange);
document.addEventListener("input", onInput);
document.addEventListener("keydown", onKeyDown);
document.addEventListener("focusin", onFocusIn);
document.addEventListener("focusout", onFocusOut);
document.addEventListener("mousedown", onMouseDown);
document.addEventListener("mouseover", onMouseOver);
document.addEventListener("mouseup", onMouseUp);
document.addEventListener("click", (e: MouseEvent) => {
    if (e.target instanceof Element && e.target.closest("#ruler")) onRulerClick(e);
    else requestAnimationFrame(renderRuler);
});
document.addEventListener("scroll", (e: Event) => { if (e.target instanceof HTMLElement && e.target.id === "main") paintRulerViewport(); }, true);
globalThis.addEventListener?.("resize", () => requestAnimationFrame(renderRuler));

setInterval(() => {
    if (!state.review || state.dragging) return;
    if (document.activeElement?.tagName === "TEXTAREA") renderTop();
    else render();
}, 30000);

if (!TOKEN) {
    requiredElement("#top").innerHTML = `<span class="del">Missing access token. Reopen the canvas.</span>`;
} else {
    loadState()
        .catch((err: unknown) => {
            requiredElement("#top").innerHTML = `<span class="del">${esc(errorMessage(err))}</span>`;
        })
        .finally(connect);
}
