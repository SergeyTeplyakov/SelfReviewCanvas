// Advisory context only: the owning agent decides when a coding task is complete.
export const COMPLETION_REVIEW_GUIDANCE = [
    "Self Review Canvas completion workflow:",
    "When you finish a user-authorized task that changed code, before your final handoff, open the relevant local Self review canvas if no matching panel is open. Open panels automatically refresh after debounced checkout changes; agents need not manually refresh after each edit. Honor explicit user opt-outs and host permissions; do not interrupt unfinished work or claim blocked work is complete.",
    "Do not open or propose another review for read-only answers, investigations without code edits, planning, or a request only to review changes. Processing a comment in an existing review should reply in-thread and keep that same review, not open another panel or create a review loop.",
    "Discover the live Self review canvas and its input/action schemas using the host's available canvas tools before calling them; do not invent signatures or fall back to a different canvas. Load the plugin's self-review skill when available for the human-led workflow.",
    "Verify the actual checkout/worktree and Git comparison for the completed task. Pass its explicit repoPath, never rely on a coordinator's working directory or a stale instance mapping. Preserve the user's selected base, path filters, exclusions and scope. Use pending for only uncommitted changes against HEAD; use all for the intended branch/PR comparison against its verified base, including committed task changes. If the intended checkout or comparison is ambiguous, ask rather than reviewing unrelated work.",
    "Reuse a known panel only after verifying its review belongs to that same checkout and comparison; focus it if needed. If no matching panel is known, choose and remember one instanceId for this task and reuse it, not a new panel on every turn. Read the review with the discovered action to confirm repoRoot, scope and revision after opening or edits; use manual refresh if automatic refresh is unavailable or the revision is stale. Never claim it opened on an error.",
    "If canvas tools/provider are unavailable, opening is blocked, or you cannot verify a matching review, briefly propose the local Self Review canvas in the final handoff and state the limitation. Do not silently substitute static HTML, install/reload software, or switch checkouts.",
    "Opening a human-led diff is not authorization to run paid or multi-model agent reviews, select models, approve fixes, commit, push, publish, or create a PR. Do none of those solely because this completion guidance is present.",
].join("\n");
/** @type {Pick<NonNullable<import("@github/copilot-sdk/extension").JoinSessionConfig["hooks"]>, "onSessionStart" | "onUserPromptSubmitted">} */
export const completionHooks = {
    onSessionStart: () => ({ additionalContext: COMPLETION_REVIEW_GUIDANCE }),
    onUserPromptSubmitted: () => ({ additionalContext: COMPLETION_REVIEW_GUIDANCE }),
};
