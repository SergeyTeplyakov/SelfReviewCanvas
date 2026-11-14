async function loadModule<T>(path: string): Promise<T> {
    return await import(new URL(path, import.meta.url).href) as T;
}

const anchors = await loadModule<typeof import("../src/lib/anchors.mjs")>("../dist/lib/anchors.mjs");
const agentReview = await loadModule<typeof import("../src/lib/agent-review.mjs")>("../dist/lib/agent-review.mjs");
const delivery = await loadModule<typeof import("../src/lib/delivery.mjs")>("../dist/lib/delivery.mjs");
const diff = await loadModule<typeof import("../src/lib/diff.mjs")>("../dist/lib/diff.mjs");
const gitModule = await loadModule<typeof import("../src/lib/git.mjs")>("../dist/lib/git.mjs");
const prompt = await loadModule<typeof import("../src/lib/prompt.mjs")>("../dist/lib/prompt.mjs");
const pullRequest = await loadModule<typeof import("../src/lib/pull-request.mjs")>("../dist/lib/pull-request.mjs");
const reviewService = await loadModule<typeof import("../src/lib/review-service.mjs")>("../dist/lib/review-service.mjs");
const reviewSkillsModule = await loadModule<typeof import("../src/lib/review-skills.mjs")>("../dist/lib/review-skills.mjs");
const server = await loadModule<typeof import("../src/lib/server.mjs")>("../dist/lib/server.mjs");
const settings = await loadModule<typeof import("../src/lib/settings.mjs")>("../dist/lib/settings.mjs");
const settingsActionsModule = await loadModule<typeof import("../src/lib/settings-actions.mjs")>("../dist/lib/settings-actions.mjs");
const settingsHttp = await loadModule<typeof import("../src/lib/settings-http.mjs")>("../dist/lib/settings-http.mjs");
const store = await loadModule<typeof import("../src/lib/store.mjs")>("../dist/lib/store.mjs");
const contracts = await loadModule<typeof import("../src/web/contracts.mjs")>("../dist/web/contracts.mjs");
const settingsApi = await loadModule<typeof import("../src/web/settings-api.mjs")>("../dist/web/settings-api.mjs");
const completionGuidance = await loadModule<typeof import("../src/lib/completion-guidance.mjs")>("../dist/lib/completion-guidance.mjs");
const reviewWatcher = await loadModule<typeof import("../src/lib/review-watcher.mjs")>("../dist/lib/review-watcher.mjs");

export const relocate = anchors.relocate;
export const { AgentReview, FUSION_REVIEWER, SUGGESTED_REVIEWERS } = agentReview;
export const { Delivery } = delivery;
export const { parseUnifiedDiff, synthesizeAddedFile, hunkAnchorRange, selectedLines, hunkExcerpt } = diff;
export const git = gitModule;
export const { runGit, captureSnapshot, readWorkingFile, safeJoin } = gitModule;
export const { buildCommentPrompt, marker } = prompt;
export const { findOpenPullRequest } = pullRequest;
export const { ReviewService, computeReviewId, scopeOf } = reviewService;
export const { ReviewSkills } = reviewSkillsModule;
export const { startReviewServer } = server;
export const { SettingsService, DEFAULT_DELIVERY, DELIVERY_MODES, resolveDelivery, normalizeRemoteUrl, pathKey, repoIdentity } = settings;
export const { settingsActions } = settingsActionsModule;
export const { SettingsHttp } = settingsHttp;
export const { Store, migrateLegacyDataRoot, defaultDataRoot } = store;
export const { agentReviewDefaults, reviewOptions, settingsDocument, settingsPatch } = contracts;
export const { createSettingsApi } = settingsApi;
export const { completionHooks, COMPLETION_REVIEW_GUIDANCE } = completionGuidance;
export const { ReviewWatcher } = reviewWatcher;

export async function loadExtension(): Promise<void> {
    const extensionUrl = new URL("../dist/extension.mjs", import.meta.url).href;
    await import(extensionUrl);
}
