import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { parseUnifiedDiff } from "./modules.mjs";
import { loadApp as runApp, MockElement } from "./load-app.mjs";

// Loads the page script into a bare vm context. Elements are created on demand and remembered per selector,
// so a test can render one piece of the page and read its markup back.
interface MockNode {
    innerHTML: string;
    textContent: string;
    className: string;
    hidden: boolean;
    inert?: boolean;
    scrollTop: number;
    focus: () => number | void;
    tagName?: string;
    dataset?: Record<string, string>;
    closest?: (selector: string) => MockNode | null;
    contains?: (node: MockNode | null) => boolean;
    classList?: { toggle: (name: string, force?: boolean) => boolean };
}

interface DialogState {
    type?: string;
    models?: string;
    skillNames?: string[];
    saveSkillDefaults?: boolean;
    saveDefaults?: boolean;
    skipDialog?: boolean;
    intent?: string;
    focus?: string;
    saving?: boolean;
    error?: string;
    learning?: string;
    delivery?: string;
    revisionId?: string;
    model?: string;
}

interface RuntimeState {
    [key: string]: unknown;
    review: Record<string, unknown> & { reviewId: string; scope?: string; threads: Array<{ status: string; messages: unknown[] }> };
    dialog: DialogState | null;
    settings: Record<string, unknown> & { learning: string; delivery: string; configured: boolean; repoName?: string } | null | undefined;
    skillOverrides: Map<string, Set<string>>;
    open: Set<string>;
    expanded: Set<string>;
    collapsedThreads: Set<string>;
    focusedComposer: string | null;
    approving: Set<string>;
    agentReviewAvailable: boolean;
    agentReviewSettingsAvailable: boolean;
    reviewSkillsAvailable: boolean;
    agentReviewSettings: { models: string[]; focus: string; intent?: string; skipDialog: boolean } | null;
    agentReviewSettingsError?: string;
    agentReviewSuggestedModels?: string[];
    busy?: boolean | null;
    startingReview?: boolean;
    switching?: boolean;
    submitting?: boolean;
    snapshot?: { revisionId?: string; files?: unknown[] };
    view?: { type?: string };
}

type MockFetch = (url: string, options?: { method?: string; body?: string }) => Promise<unknown>;
type CapturedPost = [string, ...unknown[]];
type MockFocusable = { focus?: MockNode["focus"]; checked?: boolean };

interface LoadedApp {
    document: {
        addEventListener: () => void;
        querySelector: (selector: string) => MockNode;
        querySelectorAll: (selector: string) => MockFocusable[];
        activeElement: MockFocusable | null;
    };
    sessionStorage: ReturnType<typeof mockStorage>;
    localStorage: ReturnType<typeof mockStorage>;
    focused: string[];
    node: (selector: string) => MockNode;
    state: RuntimeState;
    run: {
        (code: "onClick" | "onInput" | "onChange" | "onKeyDown" | "trapTab"): (event: unknown) => unknown;
        <T = string>(code: string): T;
    };
    read: <T = unknown,>(expression: string) => T;
}

function mockStorage() {
    const items = new Map<string, string>();
    return {
        items,
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => items.set(key, String(value)),
        removeItem: (key: string) => items.delete(key),
    };
}

async function loadApp(globals: Record<string, unknown> & { fetch?: MockFetch } = {}): Promise<LoadedApp> {
    const nodes = new Map<string, MockNode>();
    const focused: string[] = [];
    const node = (selector: string): MockNode => {
        if (!nodes.has(selector)) {
            const element = Object.assign(new MockElement(), {
                innerHTML: "", textContent: "", className: "", hidden: false, inert: false, scrollTop: 0,
                focus: () => focused.push(selector),
            });
            nodes.set(selector, element);
        }
        const found = nodes.get(selector);
        if (!found) throw new Error(`Missing mock node: ${selector}`);
        return found;
    };
    const document = { addEventListener() {}, querySelector: node, querySelectorAll: (_selector: string) => [] as MockFocusable[], activeElement: null as MockFocusable | null };
    const sessionStorage = mockStorage();
    const localStorage = (globals.localStorage as ReturnType<typeof mockStorage> | undefined) ?? mockStorage();
    const context = vm.createContext({
        URLSearchParams, location: { search: "" }, document, localStorage, sessionStorage,
        window: { setTimeout: () => 0 }, setInterval() {}, setTimeout: () => 0, clearTimeout() {}, ...globals,
    });
    await runApp(context);
    return {
        document, sessionStorage, localStorage, focused, node,
        state: vm.runInContext("state", context) as RuntimeState,
            run: Object.assign((code: string) => vm.runInContext(code, context) as unknown, {}) as LoadedApp["run"],
        read: <T = unknown,>(expression: string) => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context)) as T,
    };
}

const reviewFixture = (overrides: Record<string, unknown> = {}) => ({
    reviewId: "r", title: "Feature work", repoRoot: "C:\\repo", base: "main", branch: "feature", scope: "all", currentRevisionId: "r1",
    revisions: [{ revisionId: "r1", files: 2, additions: 3, deletions: 1, createdAt: "2026-01-01T00:00:00Z" }],
    git: { branch: "feature", headCommit: "abc", baseCommit: "def", upstream: { name: "origin/feature", ahead: 1, behind: 2 }, uncommittedFiles: 3 },
    threads: [], lessons: [],
    ...overrides,
});
const settingsFixture = (overrides: Record<string, unknown> = {}) => ({ repoName: "repo", learning: "off", delivery: "immediate", configured: false, dismissed: false, ...overrides });
const jsonResponse = (data: unknown, status = 200) => ({ ok: status < 400, status, statusText: status < 400 ? "OK" : "Error", json: async () => data });
const clicker = (app: LoadedApp) => (action: string, dataset: Record<string, string> = {}) => {
    const target = Object.assign(new MockElement("BUTTON"), { dataset: { action, ...dataset } });
    target.closest = () => target;
    return app.run("onClick")({ target });
};

function required<T>(value: T | null | undefined): T {
    assert.ok(value);
    return value;
}

const dialog = (app: LoadedApp): DialogState => required(app.state.dialog);

function requestBody(options: { method?: string; body?: string } | undefined): Record<string, unknown> {
    const body: unknown = JSON.parse(options?.body ?? "{}");
    assert.ok(typeof body === "object" && body !== null && !Array.isArray(body));
    return body as Record<string, unknown>;
}

function capturedBody(posts: CapturedPost[], index = -1): Record<string, unknown> {
    const post = required(posts.at(index));
    const body = post.at(-1);
    assert.ok(typeof body === "object" && body !== null && !Array.isArray(body));
    return body as Record<string, unknown>;
}

test("active threads can be collapsed and expanded without changing their status or replies", async () => {
    const thread = {
        threadId: "t1", kind: "line", status: "active",
        location: { path: "src/a.cs", side: "new", startLine: 10, endLine: 10, state: "current" },
        messages: [
            { messageId: "m1", author: "user", body: "Please explain this line.", createdAt: "2026-01-01T00:00:00Z" },
            { messageId: "m2", author: "agent", body: "It handles the retry.", createdAt: "2026-01-01T00:01:00Z" },
        ],
    };
    const app = await loadApp();
    app.state.review = reviewFixture({ threads: [thread] });
    app.state.snapshot = { revisionId: "r1", files: [] };
    const html = () => app.run<string>('threadHtml(state.review.threads[0])');
    const click = clicker(app);

    assert.match(html(), /aria-expanded="true">Hide/);
    await click("toggle", { thread: "t1" });
    assert.match(html(), /class="thread collapsed"/);
    assert.match(html(), /aria-expanded="false">Show/);
    assert.equal(app.state.review.threads[0].status, "active");
    assert.equal(app.state.review.threads[0].messages.length, 2);

    await click("toggle", { thread: "t1" });
    assert.doesNotMatch(html(), /class="thread collapsed"/);
    assert.match(html(), /aria-expanded="true">Hide/);
    assert.equal(app.state.review.threads[0].status, "active");
    assert.equal(app.state.review.threads[0].messages.length, 2);
});

test("hiding default-collapsed threads does not override the active, current default", async () => {
    for (const [status, locationState] of [
        ["resolved", "current"], ["wontfix", "current"], ["closed", "current"], ["active", "outdated"],
    ]) {
        const thread = {
            threadId: "t1", kind: "line", status,
            location: { path: "src/a.cs", side: "new", startLine: 10, endLine: 10, state: locationState },
            messages: [{ messageId: "m1", author: "user", body: "A comment", createdAt: "2026-01-01T00:00:00Z" }],
        };
        const app = await loadApp();
        app.state.review = reviewFixture({ threads: [thread] });
        app.state.snapshot = { revisionId: "r1", files: [] };
        const html = () => app.run<string>('threadHtml(state.review.threads[0])');
        const click = clicker(app);

        assert.match(html(), /aria-expanded="false">Show/);
        await click("toggle", { thread: "t1" });
        assert.match(html(), /aria-expanded="true">Hide/);
        await click("toggle", { thread: "t1" });
        assert.match(html(), /aria-expanded="false">Show/);
        thread.status = "active";
        thread.location.state = "current";
        assert.match(html(), /aria-expanded="true">Hide/, `${status}/${locationState} becomes active and current`);
    }
});

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const skillsApp = async (
    catalog: unknown,
    { fail = () => false, defaults }: { fail?: () => boolean; defaults?: RuntimeState["agentReviewSettings"] } = {},
) => {
    const posts: Array<[string, unknown]> = [];
    const app = await loadApp({ fetch: async (url: string, options?: { method?: string; body?: string }) => {
        if (options?.method === "POST") {
            const body: unknown = JSON.parse(options.body ?? "{}");
            posts.push([url, body]);
            return jsonResponse(url.includes("review-skills") ? catalog : typeof body === "object" && body !== null && "defaults" in body ? body.defaults : {});
        }
        if (fail()) throw new Error("Host discovery failed");
        return jsonResponse(catalog);
    } });
    app.run("loadState = async () => {}");
    app.state.review = reviewFixture();
    app.state.agentReviewAvailable = true;
    app.state.agentReviewSettingsAvailable = true;
    app.state.reviewSkillsAvailable = true;
    if (defaults) app.state.agentReviewSettings = defaults;
    return { app, posts, click: clicker(app) };
};

const NAMES = ["code-review-and-quality", "code-simplification", "ponytail-review"];
const bundledCatalog = (selected = NAMES) => ({ bundled: true, selected, defaults: { selected, saved: selected !== NAMES }, skills: NAMES.map((name, i) => ({
    name, role: i === 2 ? "ponytail" : "review", title: name, summary: `Summary of ${name}`, modified: false, sha256: "0".repeat(64),
    upstream: { repository: i === 2 ? "https://github.com/DietrichGebert/ponytail" : "https://github.com/addyosmani/agent-skills", release: i === 2 ? "v5.3.3" : "0.6.15", releaseCommit: "1".repeat(40), path: `skills/${name}/SKILL.md`, fileCommit: "abcdef1234567890" },
    license: { spdx: "MIT", files: [] }, attribution: i === 1 ? "Adapted upstream from Anthropic's code-simplifier (Apache-2.0)." : null, selected: selected.includes(name),
})) });

test("Agent review settings has a heading, General and Review skills tabs, no Run button, and bundled skills on by default with provenance", async () => {
    const { app, posts, click } = await skillsApp(bundledCatalog());
    app.state.settings = settingsFixture();
    app.run("renderTop()");
    const top = app.node("#top").innerHTML;
    assert.doesNotMatch(top, /review-skills|Review skills/);
    assert.match(top, /data-action="agent-review-configure"[^>]*>Review settings/);
    await click("agent-review-configure");
    await settle();
    let html = app.node("#dialog").innerHTML;
    assert.match(html, /<h2 id="dialog-title">Agent review settings<\/h2>/);
    assert.doesNotMatch(html, /agent-review-start|Run review/, "settings never start a review");
    assert.match(html, /role="tablist"/);
    assert.match(html, /id="review-tab-general"[^>]*aria-selected="true"[^>]*>General/);
    assert.match(html, /id="review-tab-skills"[^>]*aria-selected="false"[^>]*>Review skills/);
    assert.match(html, /id="review-panel-general"[^>]*>/);
    assert.match(html, /id="review-panel-skills"[^>]* hidden>/);
    await app.run("onInput")({ target: { name: "review-models", value: "my-reviewer" } });
    await click("review-tab", { tab: "skills" });
    html = app.node("#dialog").innerHTML;
    assert.match(html, /id="review-panel-general"[^>]* hidden>/);
    assert.match(html, /<legend>Review skills<\/legend>/);
    for (const name of NAMES) assert.match(html, new RegExp(`name="review-skill" value="${name}" checked`));
    assert.match(html, /Bundled with Self-Review: unmodified snapshot of <a href="https:\/\/github.com\/addyosmani\/agent-skills\/blob\/0.6.15\/skills\/code-review-and-quality\/SKILL.md"/);
    assert.match(html, /DietrichGebert\/ponytail v5.3.3<\/a> \(file commit abcdef1\)\. License: MIT/);
    assert.match(html, /Apache-2.0/);
    assert.doesNotMatch(html, /Refresh from host|Agent Finder|Install|review-skills-refresh/);
    assert.deepEqual(app.read("state.dialog.skillNames"), NAMES);
    assert.equal(dialog(app).models, "my-reviewer", "switching tabs keeps unsaved General choices");
    assert.equal(posts.length, 0, "opening settings never saves or starts work");
});

test("bundled skill loading failures keep unsaved choices and can be retried", async () => {
    let fail = true;
    const { app, posts, click } = await skillsApp(bundledCatalog(["ponytail-review"]), { fail: () => fail });
    await click("agent-review-configure");
    await settle();
    await app.run("onInput")({ target: { name: "review-models", value: "my-reviewer" } });
    assert.match(app.node("#dialog").innerHTML, /Host discovery failed.*data-action="review-skills-refresh"[^>]*>Retry/s);
    fail = false;
    await click("review-skills-refresh");
    assert.doesNotMatch(app.node("#dialog").innerHTML, /Host discovery failed|review-skills-refresh/);
    assert.deepEqual(app.read("state.dialog.skillNames"), ["ponytail-review"], "saved skill defaults preselect");
    assert.equal(dialog(app).models, "my-reviewer");
    assert.equal(posts.length, 0);
});

test("skill defaults require explicit opt-in; Save defaults never starts a review and choices reach one-click runs", async () => {
    const defaults = { models: ["model-a"], focus: "review", intent: "", skipDialog: true };
    const { app, posts, click } = await skillsApp(bundledCatalog(), { defaults });
    await click("agent-review-configure");
    await settle();
    assert.equal(dialog(app).saveSkillDefaults, false);
    await app.run("onChange")({ target: { name: "review-skill", value: "code-simplification", checked: false } });
    await app.run("onChange")({ target: { name: "review-save-defaults", checked: false } });
    assert.match(app.node("#dialog").innerHTML, /data-action="agent-review-save-defaults" disabled/, "nothing to save without an opt-in");
    await app.run("onChange")({ target: { name: "review-skill-defaults", checked: true } });
    assert.doesNotMatch(app.node("#dialog").innerHTML, /data-action="agent-review-save-defaults" disabled/);
    await click("agent-review-save-defaults");
    assert.deepEqual(posts, [["/api/review-skills", { names: ["code-review-and-quality", "ponytail-review"], saveDefaults: true }]]);
    assert.equal(app.state.dialog, null);
    assert.match(app.node("#toast").textContent, /No review was started/);
    await click("agent-review");
    assert.equal(posts[1][0], "/api/agent-reviews");
    assert.deepEqual(capturedBody(posts, 1).skillNames, ["code-review-and-quality", "ponytail-review"]);
    assert.equal(capturedBody(posts, 1).useDefaults, true);
});

test("Apply for this review stores a per-review skill choice on a fresh profile without saving defaults or starting a review", async () => {
    const { app, posts, click } = await skillsApp(bundledCatalog());
    await click("agent-review-configure");
    await settle();
    let html = app.node("#dialog").innerHTML;
    assert.match(html, /data-action="agent-review-save-defaults" disabled/, "a fresh profile has nothing to save");
    assert.match(html, /data-action="agent-review-apply-skills">Apply for this review/);
    await app.run("onChange")({ target: { name: "review-skill", value: "code-simplification", checked: false } });
    await click("agent-review-apply-skills");
    assert.equal(posts.length, 0, "applying never saves defaults or starts a review");
    assert.equal(app.state.dialog, null);
    assert.deepEqual([...required(app.state.skillOverrides.get("r"))], ["code-review-and-quality", "ponytail-review"]);
    assert.match(app.node("#toast").textContent, /this review only.*no review was started/i);
    await click("agent-review");
    await settle();
    assert.deepEqual(app.read("state.dialog.skillNames"), ["code-review-and-quality", "ponytail-review"], "the run dialog reuses the applied choice");
    await click("agent-review-start");
    assert.deepEqual(posts.map(([url]) => url), ["/api/agent-reviews"]);
    assert.deepEqual(capturedBody(posts, 0).skillNames, ["code-review-and-quality", "ponytail-review"]);
});

test("Run review sends this review's skill opt-outs without saving skill defaults", async () => {
    const { app, posts, click } = await skillsApp(bundledCatalog());
    await click("agent-review");
    await settle();
    assert.match(app.node("#dialog").innerHTML, /<h2 id="dialog-title">Agentic review<\/h2>.*data-action="agent-review-start"/s, "the run dialog keeps its Run button");
    await app.run("onInput")({ target: { name: "review-models", value: "my-reviewer" } });
    for (const name of NAMES) await app.run("onChange")({ target: { name: "review-skill", value: name, checked: false } });
    await app.run("onChange")({ target: { name: "review-skill", value: "ponytail-review", checked: true } });
    await click("agent-review-start");
    assert.deepEqual(posts.map(([url]) => url), ["/api/agent-reviews"]);
    assert.deepEqual(capturedBody(posts, 0).skillNames, ["ponytail-review"]);
    assert.deepEqual(capturedBody(posts, 0).models, ["my-reviewer"]);
    assert.deepEqual([...required(app.state.skillOverrides.get("r"))], ["ponytail-review"]);
});

test("the page provides every container the scope and learning controls render into", async () => {
    const html = await readFile(new URL("../dist/web/index.html", import.meta.url), "utf8");
    for (const id of ["top", "banner", "layout", "side", "main", "ruler", "dialog", "toast"]) assert.match(html, new RegExp(`id="${id}"`), id);
});

test("agent review is opt-in and its dialog collects models, focus, and guidance with optional Addy skills", async () => {
    const app = await loadApp();
    app.state.review = reviewFixture();
    app.run("renderTop()");
    assert.doesNotMatch(app.node("#top").innerHTML, /data-action="agent-review"/);
    app.state.agentReviewAvailable = true;
    app.run("renderTop()");
    assert.match(app.node("#top").innerHTML, /data-action="agent-review"/);
    const click = clicker(app);
    await click("agent-review");
    const d = required(app.state.dialog);
    assert.equal(d.type, "agent-review");
    assert.equal(d.models, "", "no paid model is implicitly selected");
    assert.equal(d.intent, "");
    assert.equal(d.revisionId, "r1");
    assert.match(app.node("#dialog").innerHTML, /may consume credits/);
    assert.match(app.node("#dialog").innerHTML, /No files are changed until you approve/);
    assert.match(app.node("#dialog").innerHTML, /role="dialog".*aria-modal="true"/);
    assert.match(app.node("#dialog").innerHTML, /Goal, spec, or review guidance \(optional\)/);
    assert.match(app.node("#dialog").innerHTML, /Bundled review skills are unavailable in this build/);
    assert.doesNotMatch(app.node("#dialog").innerHTML, /review-skills-refresh|name="review-skill"/);
    assert.match(app.node("#dialog").innerHTML, /Missing evidence is reported, not treated as a pass/);
    app.run("onInput")({ target: { name: "review-models", value: "model-a, model-b" } });
    app.run("onInput")({ target: { name: "review-intent", value: "Check the documented retry boundary." } });
    await app.run("onChange")({ target: { name: "review-focus", value: "both" } });
    assert.equal(d.models, "model-a, model-b");
    assert.equal(d.focus, "both");
    assert.equal(d.intent, "Check the documented retry boundary.");
    await click("dialog-cancel");
    assert.equal(app.state.dialog, null);
    assert.equal(app.focused.at(-1), '[data-action="agent-review"]');
});

test("built-in reviewer suggestions prefill only without saved or previous choices and never skip the dialog", async () => {
    const posts: string[] = [];
    const app = await loadApp({ fetch: async (url: string) => { posts.push(url); return jsonResponse({}); } });
    app.state.review = reviewFixture();
    app.state.agentReviewAvailable = true;
    app.state.agentReviewSuggestedModels = ["gpt-6-astra", "gpt-6.1-sol", "copilot-fusion"];
    const click = clicker(app);
    await click("agent-review");
    assert.equal(dialog(app).models, "gpt-6-astra, gpt-6.1-sol, copilot-fusion");
    assert.equal(dialog(app).saveDefaults, false, "suggestions are not saved choices");
    assert.equal(dialog(app).skipDialog, false);
    assert.match(app.node("#dialog").innerHTML, /copilot-fusion to run Copilot Fusion in a child session/);
    assert.equal(posts.length, 0, "suggestions never start a review");
    await click("dialog-cancel");
    app.state.review = reviewFixture({ agentReviews: [{ runId: "ar-last", state: "completed", focus: "simplify", models: ["model-last"], results: [] }] });
    await click("agent-review");
    assert.equal(dialog(app).models, "model-last", "the previous run wins over suggestions");
    await click("dialog-cancel");
    app.state.agentReviewSettings = { models: ["model-saved"], focus: "both", intent: "", skipDialog: false };
    await click("agent-review");
    assert.equal(dialog(app).models, "model-saved", "saved defaults win over the previous run");
    await click("dialog-cancel");
    app.state.review = reviewFixture({ agentReviews: [{ runId: "ar-fusion", state: "running", focus: "both", revisionId: "r1", models: ["model-a", "copilot-fusion"], results: [] }] });
    const html = app.run("agentReviewsHtml()");
    assert.match(html, /copilot-fusion<\/span>: Awaiting result from the Copilot Fusion child session/);
    assert.match(html, /model-a<\/span>: Awaiting result</);
    assert.equal(posts.length, 0);
});

test("the prominent review action and agent-comment counts include findings, not human threads or replies", async () => {
    const app = await loadApp();
    const thread = (id: string, status: string, revisionId: string) => ({
        threadId: id, kind: "overview", status,
        agentReview: { runId: "ar-one", model: "model-a", revisionId, assessment: "unverified" },
        messages: [{ messageId: id, author: "agent", body: "Finding", createdAt: "2026-01-01" },
            { messageId: `${id}-reply`, author: "user", body: "Discuss", createdAt: "2026-01-01" }],
    });
    app.state.review = reviewFixture({ threads: [thread("one", "active", "r1"), thread("two", "resolved", "r0"),
        { threadId: "manual", kind: "overview", status: "active", messages: [{ author: "agent", body: "Reply to human feedback" }] }] });
    app.state.agentReviewAvailable = true;
    app.state.busy = false;
    app.state.settings = settingsFixture();
    app.run("renderTop(); renderSide()");
    const html = app.node("#top").innerHTML;
    assert.deepEqual([...html.matchAll(/<section class="review-lane [^"]*" aria-labelledby="([^"]+)"/g)].map((match) => match[1]),
        ["agentic-review-title", "manual-review-title"]);
    assert.ok(html.indexOf('aria-label="Change context"') < html.indexOf("Agentic review"));
    assert.match(html, /aria-label="Change context".*Copilot idle.*Refresh/);
    assert.match(html, /class="primary agent-review-launch"[^>]*>Run agentic review/);
    assert.doesNotMatch(html, /Agent comments|agent-comment-count|data-view="agent-comments"/);
    assert.match(html, /Run agentic review.*Review settings/);
    assert.match(html, /aria-labelledby="manual-review-title".*Delivery: Immediate.*Learning: Off.*Manual review settings/);
    assert.match(app.node("#side").innerHTML, /data-view="overview".*<span class="count"[^>]*>2<\/span><span class="name">Agent reviews<\/span>/);
    assert.doesNotMatch(app.run("overviewView()"), /agent-review-run|Review runs|<h2>Revisions/, "Overview omits agent review runs and the revisions list");
    assert.match(app.run("agentCommentsView()"), /1 active, 1 closed or resolved; 1 from older revisions/);
    assert.doesNotMatch(app.run("agentCommentsView()"), /Reply to human feedback/);
    await clicker(app)("nav", { view: "agent-comments" });
    assert.equal(required(app.state.view).type, "agent-comments");
    assert.match(app.node("#main").innerHTML, /<h2>Agent reviews<\/h2>.*Agent comments \(<span aria-live="polite">2<\/span>\)/);
    app.state.review = reviewFixture({ agentReviews: [{ state: "running" }] });
    app.run("renderTop()");
    assert.match(app.node("#top").innerHTML, /data-action="agent-review"[^>]*disabled>Agentic review running/);
    assert.equal(app.run("agentComments().length"), 0, "scope switches never carry another scope's counts");
});

test("saved user choices prefill configuration and save-only never starts a review", async () => {
    const posts: CapturedPost[] = [];
    const defaults = { models: ["model-a"], focus: "both", intent: "Check contracts.", skipDialog: true };
    const app = await loadApp({
        fetch: async (url: string, opts?: { method?: string; body?: string }) => {
            posts.push([url, requestBody(opts)]);
            return jsonResponse(requestBody(opts).defaults);
        },
    });
    app.run("loadState = async () => {}");
    app.state.review = reviewFixture();
    app.state.agentReviewAvailable = true;
    app.state.agentReviewSettingsAvailable = true;
    app.state.agentReviewSettings = defaults;
    await clicker(app)("agent-review-configure");
    assert.equal(dialog(app).models, "model-a");
    assert.equal(dialog(app).intent, "Check contracts.");
    assert.equal(dialog(app).skipDialog, true);
    assert.match(app.node("#dialog").innerHTML, /User defaults for all repositories/);
    await app.run("onChange")({ target: { name: "review-skip-dialog", checked: false } });
    await clicker(app)("agent-review-save-defaults");
    assert.deepEqual(posts, [["/api/agent-review-settings", { defaults: { ...defaults, skipDialog: false } }]]);
    assert.equal(app.state.dialog, null);
    assert.equal(required(app.state.agentReviewSettings).skipDialog, false);
    await clicker(app)("agent-review");
    assert.equal(dialog(app).type, "agent-review", "disabling one-click brings back the dialog");
    assert.equal(posts.length, 1, "opening configuration never launches work");
});

test("one-click run skips the dialog, uses the current revision, and guards repeated clicks", async () => {
    let finish: (() => void) | undefined;
    const posts: CapturedPost[] = [];
    const app = await loadApp({ fetch: async (url: string, opts?: { method?: string; body?: string }) => {
        posts.push([url, requestBody(opts)]);
        return new Promise((resolve) => { finish = () => resolve(jsonResponse({ state: "queued" })); });
    } });
    app.run("loadState = async () => {}");
    app.state.review = reviewFixture();
    app.state.agentReviewAvailable = true;
    app.state.agentReviewSettings = { models: ["model-a"], focus: "both", intent: "", skipDialog: true };
    const first = clicker(app)("agent-review");
    await clicker(app)("agent-review");
    assert.equal(app.state.dialog, null);
    assert.equal(app.state.startingReview, true);
    assert.deepEqual(posts, [["/api/agent-reviews", { useDefaults: true, oneClick: true, revisionId: "r1" }]]);
    required(finish)();
    await first;
    assert.equal(app.state.startingReview, false);
});

test("one-click run reloads defaults and requires the same scope and revision", async () => {
    const app = await loadApp();
    app.run('loadState = async () => { state.agentReviewSettings = { models: ["updated-model"], focus: "review", skipDialog: false }; }');
    app.state.review = reviewFixture();
    app.state.agentReviewAvailable = true;
    app.state.agentReviewSettings = { models: ["stale-model"], focus: "both", skipDialog: true };
    await clicker(app)("agent-review");
    assert.equal(app.state.dialog?.type, "agent-review");
    assert.equal(dialog(app).models, "updated-model");
    assert.equal(app.state.startingReview, false);

    app.state.dialog = null;
    app.state.agentReviewSettings = { models: ["model-a"], focus: "both", skipDialog: true };
    app.run('loadState = async () => { state.review = { ...state.review, reviewId: "other-scope" }; }');
    await clicker(app)("agent-review");
    assert.equal(app.state.dialog, null);
    assert.equal(app.state.startingReview, false);
    assert.match(app.node("#toast").textContent, /scope or revision changed/);

    app.state.review = reviewFixture();
    app.state.agentReviewSettings = { models: ["model-a"], focus: "both", skipDialog: true };
    app.run('loadState = async () => { state.review = { ...state.review, currentRevisionId: "r2" }; }');
    await clicker(app)("agent-review");
    assert.equal(app.state.dialog, null);
    assert.equal(app.state.startingReview, false);
    assert.match(app.node("#toast").textContent, /scope or revision changed/);
});

test("saving defaults during a scope or revision change does not start an unconfirmed review", async () => {
    for (const change of [
        { reviewId: "other-scope", currentRevisionId: "other-r1" },
        { reviewId: "r", currentRevisionId: "r2" },
    ]) {
        let app: LoadedApp;
        const posts: CapturedPost[] = [];
        app = await loadApp({ fetch: async (url: string, opts?: { method?: string; body?: string }) => {
            posts.push([url, requestBody(opts)]);
            app.state.review = reviewFixture(change);
            return jsonResponse({ models: ["model-a"], focus: "both", intent: "", skipDialog: true });
        } });
        app.run("loadState = async () => {}");
        app.state.review = reviewFixture();
        app.state.agentReviewAvailable = true;
        app.state.agentReviewSettingsAvailable = true;
        app.run("openAgentReview()");
        dialog(app).models = "model-a";
        dialog(app).saveDefaults = true;
        await app.run("startAgentReview()");
        assert.deepEqual(posts.map(([url]) => url), ["/api/agent-review-settings"]);
        assert.match(required(dialog(app).error), /scope changed or revision is stale/);
        assert.equal(dialog(app).saving, false);
    }
});

test("saving user defaults remains available after the review scope or revision changes", async () => {
    for (const change of [
        { reviewId: "other-scope", currentRevisionId: "other-r1" },
        { reviewId: "r", currentRevisionId: "r2" },
    ]) {
        const posts: CapturedPost[] = [];
        const app = await loadApp({ fetch: async (url: string, opts?: { method?: string; body?: string }) => {
            posts.push([url, requestBody(opts)]);
            return jsonResponse({ models: ["model-a"], focus: "both", intent: "", skipDialog: false });
        } });
        app.run("loadState = async () => {}");
        app.state.review = reviewFixture();
        app.state.agentReviewAvailable = true;
        app.state.agentReviewSettingsAvailable = true;
        app.run("openAgentReview()");
        dialog(app).models = "model-a";
        dialog(app).saveDefaults = true;
        app.state.review = reviewFixture(change);
        await app.run("startAgentReview(true)");
        assert.deepEqual(posts, [["/api/agent-review-settings", {
            defaults: { models: ["model-a"], focus: "review", intent: "", skipDialog: false },
        }]]);
        assert.equal(app.state.dialog, null);
        assert.match(app.node("#toast").textContent, /User defaults saved\. No review was started/);
    }
});

test("one-click failures surface errors and release the button even if reloading state fails", async () => {
    for (const reloadFails of [false, true]) {
        const app = await loadApp({ fetch: async () => jsonResponse({ error: { message: "Review could not be queued" } }, 500) });
        app.run(reloadFails ? 'loadState = async () => { throw new Error("State reload failed"); }' : "loadState = async () => {}");
        app.state.review = reviewFixture();
        app.state.agentReviewAvailable = true;
        app.state.agentReviewSettings = { models: ["model-a"], focus: "both", skipDialog: true };
        await clicker(app)("agent-review");
        assert.equal(app.state.startingReview, false);
        assert.equal(app.state.dialog, null);
        assert.match(app.node("#top").innerHTML, /data-action="agent-review"[^>]*>Run agentic review/);
        assert.doesNotMatch(app.node("#top").innerHTML, /data-action="agent-review"[^>]*disabled/);
        assert.equal(app.node("#toast").textContent, reloadFails ? "State reload failed" : "Review could not be queued");
        assert.match(app.node("#toast").className, /error/);
    }
});

test("failed settings saves stay visible and never start a review", async () => {
    const posts: string[] = [];
    const app = await loadApp({ fetch: async (url: string) => {
        posts.push(url);
        return jsonResponse({ error: { message: "Disk is read-only" } }, 500);
    } });
    app.run("loadState = async () => {}");
    app.state.review = reviewFixture();
    app.state.agentReviewAvailable = true;
    app.state.agentReviewSettingsAvailable = true;
    app.run("openAgentReview()");
    dialog(app).models = "model-a";
    dialog(app).saveDefaults = true;
    await app.run("startAgentReview()");
    assert.deepEqual(posts, ["/api/agent-review-settings"]);
    assert.match(app.node("#dialog").innerHTML, /role="alert">Disk is read-only/);
    assert.equal(dialog(app).saving, false);
});

test("an unreadable profile exposes its error instead of silently running different choices", async () => {
    const app = await loadApp();
    app.state.review = reviewFixture();
    app.state.agentReviewAvailable = true;
    app.state.agentReviewSettingsError = "Could not read agent review defaults: invalid JSON";
    await clicker(app)("agent-review");
    assert.match(app.node("#dialog").innerHTML, /role="alert">Could not read agent review defaults/);
    assert.equal(dialog(app).models, "");
});

test("agent review traps keyboard focus including guidance and the optional skill link while queuing", async () => {
    const app = await loadApp();
    app.state.dialog = { type: "agent-review", saving: false };
    const focus: string[] = [];
    const input = { focus: () => focus.push("models") };
    const guidance = { focus: () => focus.push("guidance") };
    const link = { focus: () => focus.push("skills") };
    const button = { focus: () => focus.push("run") };
    app.document.querySelectorAll = (selector: string) => {
        assert.match(selector, /#dialog textarea:not\(\[disabled\]\)/);
        assert.match(selector, /#dialog a\[href\]/);
        return dialog(app).saving ? [link] : [input, guidance, link, button];
    };
    let prevented = 0;
    const press = (shiftKey: boolean) => app.run("trapTab")({ shiftKey, preventDefault: () => prevented++ });
    app.document.activeElement = input;
    press(true);
    app.document.activeElement = button;
    press(false);
    app.document.activeElement = guidance;
    press(false);
    assert.deepEqual(focus, ["run", "models"]);
    assert.equal(prevented, 2);
    dialog(app).saving = true;
    app.document.activeElement = link;
    press(false);
    press(true);
    assert.deepEqual(focus, ["run", "models", "skills", "skills"]);
    assert.equal(prevented, 4);
});

test("agent review start sends selected models and pinned revision and preserves errors in the dialog", async () => {
    const posts: CapturedPost[] = [];
    const app = await loadApp({
        fetch: async (url: string, opts?: { method?: string; body?: string }) => {
            if (opts?.method === "POST") {
                posts.push([url, requestBody(opts)]);
                return jsonResponse({ error: { message: "Selected model unavailable" } }, 400);
            }
            return jsonResponse({ review: reviewFixture(), agentReviewAvailable: true });
        },
    });
    app.run("loadState = async () => {}");
    app.state.review = reviewFixture();
    app.state.agentReviewAvailable = true;
    app.run("openAgentReview()");
    dialog(app).models = "model-a, model-b";
    dialog(app).focus = "both";
    dialog(app).intent = "Use Addy's skills if installed.";
    await app.run("startAgentReview()");
    assert.deepEqual(posts, [["/api/agent-reviews", { models: ["model-a", "model-b"], focus: "both", intent: "Use Addy's skills if installed.", revisionId: "r1" }]]);
    assert.equal(dialog(app).saving, false);
    assert.match(app.node("#dialog").innerHTML, /role="alert">Selected model unavailable/);
    app.state.review.reviewId = "different-scope";
    await app.run("startAgentReview()");
    assert.equal(posts.length, 1, "an old dialog must not launch into the newly selected scope");
    assert.match(required(dialog(app).error), /scope changed/);
});

test("agent review results distinguish findings, assessments, limits, and missing or failed model outcomes", async () => {
    const app = await loadApp();
    app.state.review = reviewFixture({
        agentReviews: [{
            runId: "ar-one", state: "running", focus: "both", revisionId: "r0",
            intent: "<goal>",
            models: ["model-a", "<bad-model>", "model-c", "model-d"],
            results: [
                { model: "model-a", state: "completed", threadIds: [], summary: "<coverage>: spec unavailable; tests not run." },
                { model: "<bad-model>", state: "failed", error: "<failed>" },
                { model: "model-d", state: "completed", threadIds: ["t1", "t2", "t3", "t4"] },
            ],
        }],
        threads: [
            { threadId: "t1", agentReview: { assessment: "confirmed" } },
            { threadId: "t2", agentReview: { assessment: "pre-existing" } },
            { threadId: "t3", agentReview: { assessment: "rejected" } },
            { threadId: "t4", agentReview: {} },
        ],
    });
    const html = app.run("agentReviewsHtml()");
    assert.match(html, /model-a<\/span>: No findings reported/);
    assert.match(html, /&lt;bad-model&gt;<\/span>: Failed: &lt;failed&gt;/);
    assert.match(html, /model-c<\/span>: Awaiting result/);
    assert.match(html, /model-d<\/span>: 1 confirmed, 1 pre-existing, 1 rejected, 1 unverified/);
    assert.match(html, /&lt;coverage&gt;: spec unavailable; tests not run/);
    assert.match(html, /Goal \/ spec \/ guidance: &lt;goal&gt;/);
    assert.match(html, /No coverage or verification summary recorded/);
    assert.match(html, /older diff/);
    assert.match(html, /does not stop agents already running/);
    assert.doesNotMatch(html, /<bad-model>|<failed>|<coverage>|<goal>/);
});

test("model findings have Approve and Discuss controls; stale, closed, and approved findings cannot be approved again", async () => {
    const app = await loadApp();
    app.state.review = reviewFixture();
    const thread: {
        threadId: string;
        kind: string;
        status: string;
        messages: Array<{ messageId: string; author: string; body: string; createdAt: string }>;
        agentReview?: {
            model: string;
            category: string;
            revisionId: string;
            assessment: string | undefined;
            severity: string;
            evidence: { source: string; baseline: string; validation: string };
            approvalMessageId?: string;
        };
    } = {
        threadId: "t-model", kind: "overview", status: "active", messages: [{ messageId: "m", author: "agent", body: "A suggestion", createdAt: new Date().toISOString() }],
        agentReview: {
            model: "<model>", category: "simplification", revisionId: "r1", assessment: "confirmed", severity: "optional",
            evidence: { source: "source <unsafe>", baseline: "The old flow has the same behavior.", validation: "Compared side effects; no tests run." },
        },
    };
    const html = () => app.run(`threadHtml(${JSON.stringify(thread)})`);
    const finding = required(thread.agentReview);
    assert.match(html(), /&lt;model&gt; \/ simplification/);
    assert.match(html(), /data-action="approve-finding"[^>]*>Approve/);
    assert.match(html(), /data-action="discuss-finding"/);
    assert.match(html(), /Agent assessment|Assessment reported by the coordinating agent/);
    assert.match(html(), />Confirmed<\/span>/);
    assert.match(html(), />Optional<\/span>/);
    assert.match(html(), /Evidence and verification/);
    assert.match(html(), /source &lt;unsafe&gt;/);
    assert.doesNotMatch(html(), /<unsafe>/);
    for (const assessment of ["pre-existing", "rejected", "unverified", undefined]) {
        finding.assessment = assessment;
        assert.match(html(), /data-action="approve-finding"[^>]*disabled/, `${assessment} is not approvable`);
        assert.match(html(), /data-action="discuss-finding"/);
    }
    finding.assessment = "confirmed";
    finding.severity = "fyi";
    assert.match(html(), /data-action="approve-finding"[^>]*disabled/);
    finding.severity = "optional";
    finding.evidence.baseline = "";
    assert.match(html(), /data-action="approve-finding"[^>]*disabled/);
    finding.evidence.baseline = "Compared both sides.";
    finding.revisionId = "r0";
    assert.match(html(), /data-action="approve-finding"[^>]*disabled/);
    finding.revisionId = "r1";
    finding.approvalMessageId = "approved";
    assert.match(html(), /disabled>Approved/);
    delete finding.approvalMessageId;
    thread.status = "closed";
    assert.match(html(), /data-action="approve-finding"[^>]*disabled/);
    delete thread.agentReview;
    assert.doesNotMatch(html(), /approve-finding|discuss-finding/);
});

test("Discuss only opens a composer; Approve explicitly sends the finding and reports delivery failure", async () => {
    const posts: CapturedPost[] = [];
    const app = await loadApp({
        fetch: async (url: string, opts?: { method?: string; body?: string }) => {
            posts.push([url, requestBody(opts)]);
            return jsonResponse({ error: "transport unavailable" });
        },
    });
    app.run("render = () => {}; loadState = async () => {}; focusComposer = (key) => { state.focusedComposer = key; }");
    app.state.review = reviewFixture();
    const click = clicker(app);
    await click("discuss-finding", { thread: "t1" });
    assert.deepEqual(posts, [], "opening a discussion sends nothing");
    assert.equal(app.state.open.has("reply:t1"), true);
    assert.equal(app.state.focusedComposer, "reply:t1");
    await click("approve-finding", { thread: "t1" });
    assert.deepEqual(posts, [["/api/threads/t1/approve", { revisionId: "r1" }]]);
    assert.match(app.node("#toast").textContent, /delivery failed: transport unavailable/);
    assert.equal(app.state.approving.size, 0);
});

test("file views show mode changes and side-specific EOF notes without selectable phantom lines", async () => {
    const app = await loadApp();
    app.state.review = reviewFixture();
    const diff = "diff --git a/a.txt b/a.txt\nold mode 100644\nnew mode 100755\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-same\n\\ No newline at end of file\n+same\n";
    const [file] = parseUnifiedDiff(diff);
    app.state.files = [file];
    const html = app.run(`fileView(${JSON.stringify(file)}, { stacked: true })`);
    assert.match(html, /File mode: 100644 to 100755/);
    assert.match(html, /class="eof-note".*No newline at end of file \(old side\)/);
    assert.equal((html.match(/<tr class="row /g) ?? []).length, 2);
    const note = required(html.match(/<tr class="eof-note">.*?<\/tr>/))[0];
    assert.doesNotMatch(note, /data-h=|data-i=/, "EOF metadata does not change source row indices or selection");
    file.hunks[0].rows[0].noNewlineAtEnd = false;
    file.hunks[0].rows[1].noNewlineAtEnd = true;
    assert.match(app.run(`fileView(${JSON.stringify(file)}, { stacked: true })`), /No newline at end of file \(new side\)/);
    file.hunks = [];
    assert.match(app.run(`fileView(${JSON.stringify(file)}, { stacked: true })`), /File mode: 100644 to 100755/);
});

test("loads nullable values from review state and labels unavailable upstream counts", async () => {
    let review: unknown = reviewFixture({
        scope: "pending",
        base: null,
        currentRevisionId: null,
        revisions: [],
        git: { branch: "feature", headCommit: "abc", baseCommit: null, upstream: { name: "origin/feature", ahead: null, behind: null }, uncommittedFiles: 0 },
        description: { version: 1, revisionId: null, body: "Draft" },
    });

    const app = await loadApp({
        fetch: async (url: string) => {
            if (url === "/api/state") return jsonResponse({ review, session: { busy: null }, settings: settingsFixture() });
            if (url === "/api/snapshot/r1") return jsonResponse({ revisionId: "r1", files: [] });
            throw new Error(`unexpected request ${url}`);
        },
    });
    app.run("render = () => {}");

    await app.run("loadState()");
    assert.equal(app.state.review.base, null);
    assert.equal(app.state.busy, null);
    assert.deepEqual(app.state.review.description, { version: 1, revisionId: null, body: "Draft" });

    review = reviewFixture({
        git: { branch: "feature", headCommit: "abc", baseCommit: "def", upstream: { name: "origin/feature", ahead: null, behind: null }, uncommittedFiles: 0 },
    });
    await app.run("loadState()");
    app.run("renderTop()");
    assert.match(app.node("#top").innerHTML, /↑\? ↓\?/);
});

test("revision reload preserves composer text and posts a changed-line draft against its original revision", async () => {
    const posts: Record<string, unknown>[] = [];
    const app = await loadApp({
        CSS: { escape: (value: string) => value },
        fetch: async (url: string, options?: { method?: string; body?: string }) => {
            if (options?.method === "POST") {
                posts.push(requestBody(options));
                return jsonResponse({ threadId: "posted" });
            }
            if (url === "/api/state") return jsonResponse({ review: reviewFixture({ currentRevisionId: "r2" }), settings: settingsFixture() });
            if (url === "/api/snapshot/r2") return jsonResponse({ revisionId: "r2", files: [] });
            throw new Error(`unexpected request ${url}`);
        },
    });
    app.state.review = reviewFixture();
    app.state.settings = settingsFixture();
    const key = "line:file.ts:new:2-2";
    const textarea = { value: "unfinished feedback", dataset: { composer: key }, focus() {} };
    const box = Object.assign(new MockElement(), {
        dataset: { key, kind: "line", path: "file.ts", side: "new", start: "2", end: "2", revision: "r1" },
        querySelector: (selector: string) => selector === "textarea" ? textarea : { textContent: "Comment on L2" },
    });
    app.document.querySelectorAll = () => [box];
    app.document.querySelector = (selector: string) => selector.startsWith(".composer") ? box : app.node(selector);
    app.run(`composerHtml("hidden-change", { kind: "change", path: "other.ts", side: "new", startLine: 4, endLine: 4, alwaysOpen: true }); setDraft("hidden-change", "another unfinished comment")`);
    app.run("render = () => {}; state.selection = { path: 'file.ts', hunk: 0, from: 1, to: 1, anchor: 1, full: false }");
    await app.run("loadState()");
    assert.equal(app.state.review.currentRevisionId, "r2");
    assert.equal(app.state.selection, null, "old row indices are never reused on the new diff");
    const pinnedKey = `pinned:r1:${key}`;
    assert.equal(app.run(`getDraft(${JSON.stringify(pinnedKey)})`), "unfinished feedback");
    assert.equal(textarea.dataset.composer, pinnedKey, "focus follows the migrated draft");
    assert.equal(app.run(`getDraft(${JSON.stringify(key)})`), "", "the current revision can reuse the same selection");
    const pinned = app.run(`composerHtml(${JSON.stringify(pinnedKey)}, pinnedComposers.get(${JSON.stringify(pinnedKey)}))`);
    assert.match(pinned, /data-revision="r1"/);
    assert.match(pinned, /unfinished feedback/);
    const hidden = app.run(`composerHtml("pinned:r1:hidden-change", pinnedComposers.get("pinned:r1:hidden-change"))`);
    assert.match(hidden, /data-revision="r1"/);
    assert.match(hidden, /another unfinished comment/);
    const current = app.run(`composerHtml(${JSON.stringify(key)}, { kind: "line", path: "file.ts", startLine: 2, endLine: 2, alwaysOpen: true })`);
    assert.match(current, /data-revision="r2"/);
    await app.run(`submit(${JSON.stringify(pinnedKey)})`);
    assert.equal(posts[0].revisionId, "r1");
    assert.equal(posts[0].body, "unfinished feedback");
    assert.equal(app.read("pinnedComposers.size"), 1);
    app.run(`closeComposer("pinned:r1:hidden-change", true)`);
    assert.equal(app.read("pinnedComposers.size"), 0);
});

test("refresh drops empty selection contexts and pins later hidden drafts to the revision they were written against", async () => {
    const app = await loadApp();
    app.state.review = reviewFixture();
    const options = `{ kind: "line", path: "file.ts", side: "new", startLine: 2, endLine: 2, alwaysOpen: true }`;
    app.run(`composerHtml("line:file.ts:new:2-2", ${options}); pinComposers()`);
    assert.equal(app.read("pinnedComposers.size"), 0);
    assert.equal(app.read("composerContexts.size"), 0);
    app.state.review.currentRevisionId = "r2";
    app.run(`composerHtml("line:file.ts:new:2-2", ${options}); setDraft("line:file.ts:new:2-2", "feedback on r2"); pinComposers()`);
    assert.equal(app.read(`pinnedComposers.get("pinned:r2:line:file.ts:new:2-2").revisionId`), "r2");
    app.state.review.currentRevisionId = "r3";
    assert.match(app.run(`composerHtml("line:file.ts:new:2-2", ${options})`), /data-revision="r3"/);
});

test("refresh does not pin empty visible composers and keeps file drafts visible when a file leaves the diff", async () => {
    const app = await loadApp();
    app.state.review = reviewFixture();
    app.state.settings = settingsFixture();
    const empty = { value: "", dataset: { composer: "line:file.ts:new:2-2" } };
    const box = Object.assign(new MockElement(), {
        dataset: { key: empty.dataset.composer, kind: "line", path: "file.ts", side: "new", start: "2", end: "2", revision: "r1" },
        querySelector: (selector: string) => selector === "textarea" ? empty : null,
    });
    app.document.querySelectorAll = () => [box];
    app.run(`composerHtml("file:gone.ts", { kind: "file", path: "gone.ts", alwaysOpen: true }); setDraft("file:gone.ts", "keep this file comment"); pinComposers()`);
    assert.equal(app.read("pinnedComposers.size"), 1, "only the nonempty hidden file draft is pinned");
    app.state.review.currentRevisionId = "r2";
    app.run(`state.snapshot = { revisionId: "r2", files: [] }; state.view = { type: "file", path: "gone.ts" }; renderRuler = () => {}; render()`);
    assert.equal(app.read("state.view.type"), "overview");
    assert.match(app.node("#main").innerHTML, /keep this file comment/);
    assert.match(app.node("#main").innerHTML, /data-kind="file".*data-path="gone.ts"/);
});

test("an in-flight submission completes the migrated draft without deleting a new current-revision draft", async () => {
    let finishPost: (value: unknown) => void = () => { throw new Error("POST not started"); };
    const app = await loadApp({
        CSS: { escape: (value: string) => value },
        fetch: async (_url: string, options?: { method?: string; body?: string }) => {
            assert.equal(options?.method, "POST");
            return new Promise((resolve) => { finishPost = resolve; });
        },
    });
    app.state.review = reviewFixture();
    const textarea = { value: "sending original", dataset: { composer: "line:file.ts:new:2-2" } };
    const box = Object.assign(new MockElement(), {
        dataset: { key: textarea.dataset.composer, kind: "line", path: "file.ts", side: "new", start: "2", end: "2", revision: "r1" },
        querySelector: (selector: string) => selector === "textarea" ? textarea : null,
    });
    app.document.querySelectorAll = () => [box];
    app.document.querySelector = (selector: string) => selector.startsWith(".composer") ? box : app.node(selector);
    app.run("render = () => {}; loadState = async () => {}");
    const submitted = app.run<Promise<void>>(`submit("line:file.ts:new:2-2")`);
    app.run(`pinComposers(); state.review.currentRevisionId = "r2"; setDraft("line:file.ts:new:2-2", "new feedback")`);
    finishPost(jsonResponse({}));
    await submitted;
    assert.equal(app.read("pinnedComposers.size"), 0);
    assert.equal(app.run(`getDraft("line:file.ts:new:2-2")`), "new feedback");
});

test("pinned composer text and original revision survive reload and scope switches", async () => {
    let activeReview = reviewFixture();
    const fetch: MockFetch = async (url) => {
        if (url === "/api/state") return jsonResponse({ review: activeReview, settings: settingsFixture() });
        if (url.startsWith("/api/snapshot/")) return jsonResponse({ revisionId: activeReview.currentRevisionId, files: [] });
        throw new Error(`unexpected request ${url}`);
    };
    const app = await loadApp({ fetch });
    app.run("renderRuler = () => {}");
    await app.run("loadState()");
    const key = "line:file.ts:new:2-2";
    app.run(`composerHtml(${JSON.stringify(key)}, { kind: "line", path: "file.ts", side: "new", startLine: 2, endLine: 2, revisionId: "r1", alwaysOpen: true }); setDraft(${JSON.stringify(key)}, "keep across reload"); pinComposers()`);
    const pinnedKey = `pinned:r1:${key}`;
    assert.ok(app.localStorage.getItem("sr:r:draft:" + pinnedKey));
    assert.ok(app.localStorage.getItem("sr:r:pinned-composers"));

    activeReview = reviewFixture({ reviewId: "pending-review", currentRevisionId: "p1", scope: "pending" });
    await app.run("loadState()");
    assert.equal(app.read("pinnedComposers.size"), 0, "another scope does not display this draft");
    activeReview = reviewFixture();
    await app.run("loadState()");
    assert.equal(app.read(`pinnedComposers.get(${JSON.stringify(pinnedKey)}).revisionId`), "r1");
    assert.match(app.run(`composerHtml(${JSON.stringify(pinnedKey)}, pinnedComposers.get(${JSON.stringify(pinnedKey)}))`), /keep across reload/);

    const reloaded = await loadApp({ fetch, localStorage: app.localStorage });
    reloaded.run("renderRuler = () => {}");
    await reloaded.run("loadState()");
    assert.equal(reloaded.read(`pinnedComposers.get(${JSON.stringify(pinnedKey)}).revisionId`), "r1");
    assert.match(reloaded.run(`composerHtml(${JSON.stringify(pinnedKey)}, pinnedComposers.get(${JSON.stringify(pinnedKey)}))`), /keep across reload/);
});

test("the top bar shows the review scope, and the learning controls only when the settings are known", async () => {
    const app = await loadApp();
    const top = () => {
        app.run("renderTop()");
        return app.node("#top").innerHTML;
    };
    const toggle = (html: string) => required(html.match(/<span class="seg"[^>]*>.*?<\/span>/))[0];
    app.state.settings = settingsFixture({ configured: true });

    app.state.review = reviewFixture();
    let html = top();
    assert.match(html, /data-scope="all" aria-pressed="true"/);
    assert.match(html, /data-scope="pending" aria-pressed="false"/);
    assert.match(html, /<span class="muted">vs<\/span><span class="pill mono" title="merge-base def">main<\/span>/);
    assert.match(html, /↑1 ↓2/);
    assert.match(html, />3 uncommitted</);
    assert.doesNotMatch(toggle(html), /disabled/);

    app.state.pullRequest = { number: 7, url: "https://github.com/SergeyTeplyakov/Self-Review/pull/7" };
    html = top();
    assert.match(html, /<a class="pill pr-link" href="https:\/\/github\.com\/SergeyTeplyakov\/Self-Review\/pull\/7" target="_blank" rel="noopener noreferrer" title="Open pull request #7 in browser">Open PR #7<\/a>/);
    app.state.pullRequest = null;
    assert.doesNotMatch(top(), /Open PR #7/);

    app.state.review = reviewFixture({ git: { branch: "feature", uncommittedFiles: 0 } });
    html = top();
    assert.match(html, /no upstream/);
    assert.doesNotMatch(html, /\d+ uncommitted/);

    app.state.review = reviewFixture({ scope: "pending", title: "feature (pending changes)", branch: 'x"><img src=1>' });
    html = top();
    assert.match(html, /data-scope="all" aria-pressed="false"/);
    assert.match(html, /data-scope="pending" aria-pressed="true"/);
    assert.match(html, /<span class="muted">uncommitted changes only<\/span>/);
    assert.doesNotMatch(html, />vs<|merge-base|↑|no upstream|\d+ uncommitted|<img/, "pending changes have no base, upstream or uncommitted count to show");

    app.state.switching = true;
    assert.equal(required(toggle(top()).match(/ disabled/g)).length, 2, "both scope buttons are disabled while a switch is in flight");
    app.state.switching = false;

    for (const [learning, pill] of [["off", "Off"], ["suggest", "Suggest"], ["auto", "Auto-save"], ["unexpected", "Off"]]) {
        app.state.settings = settingsFixture({ learning, configured: true });
        assert.match(top(), new RegExp(`Learning: ${pill}</span><button data-action="configure"[^>]*>Manual review settings`), learning);
    }
    app.state.settings = null;
    html = top();
    assert.doesNotMatch(html, /Learning:|Manual review settings|data-action="configure"/);
    assert.match(html, /aria-labelledby="manual-review-title"/);
    assert.match(html, /data-action="refresh"/);
});

test("the first-use banner offers Suggest or Save automatically, never Off, and only while the repository is undecided", async () => {
    const app = await loadApp();
    const banner = (settings: RuntimeState["settings"]) => {
        app.state.settings = settings;
        app.run("renderBanner()");
        return app.node("#banner");
    };
    assert.equal(banner(null).hidden, true);
    assert.equal(banner(settingsFixture({ configured: true })).hidden, true);
    assert.equal(banner(settingsFixture({ dismissed: true })).hidden, true);
    assert.equal(app.node("#banner").innerHTML, "");

    const shown = banner(settingsFixture({ repoName: "<img src=x>" }));
    assert.equal(shown.hidden, false);
    assert.match(shown.innerHTML, /Learn from your review feedback in &lt;img src=x&gt;\?/);
    assert.doesNotMatch(shown.innerHTML, /<img/);
    assert.match(shown.innerHTML, /data-action="learning-set" data-mode="suggest" class="primary"[^>]*>Suggest</);
    assert.match(shown.innerHTML, /data-action="learning-set" data-mode="auto"(?! class="primary")[^>]*>Save automatically</);
    assert.doesNotMatch(shown.innerHTML, /data-mode="off"/);
    assert.match(shown.innerHTML, /data-action="learning-dismiss"[^>]*>Not now</);
});

test("the Configure dialog is an accessible modal that preselects the draft mode and locks while saving", async () => {
    const app = await loadApp();
    assert.equal(app.run("dialogHtml()"), "", "closed by default");
    app.state.settings = settingsFixture({ repoName: "Org/Repo <x>", learning: "suggest", configured: true });
    app.state.dialog = { learning: "suggest", delivery: "batch", saving: false, error: "" };
    const html = app.run("dialogHtml()");
    assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-desc"/);
    assert.match(html, /<h2 id="dialog-title">Review settings<\/h2>/);
    assert.match(html, /<p id="dialog-desc" class="muted">Settings for Org\/Repo &lt;x&gt;\. /);
    assert.match(html, /<legend>Learn from review feedback<\/legend>.*<legend>Send comments to Copilot<\/legend>/);
    assert.deepEqual(
        [...html.matchAll(/<input type="radio" name="learning" value="(\w+)"( checked)?>/g)].map((m) => [m[1], Boolean(m[2])]),
        [["off", false], ["suggest", true], ["auto", false]],
    );
    assert.deepEqual(
        [...html.matchAll(/<input type="radio" name="delivery" value="(\w+)"( checked)?>/g)].map((m) => [m[1], Boolean(m[2])]),
        [["immediate", false], ["batch", true], ["ask", false]],
    );
    assert.match(html, /<span class="choice-title">Save automatically<\/span>/);
    assert.match(html, /<span class="choice-title">Ask for each review<\/span>/);
    assert.doesNotMatch(html, /role="alert"|\sdisabled[\s>]/);
    assert.match(html, /data-action="dialog-save">Save<\/button>/);

    app.state.dialog = { learning: "auto", saving: true, error: "Could not save <b>" };
    const busy = app.run("dialogHtml()");
    assert.match(busy, /<div class="modal-error" role="alert">Could not save &lt;b&gt;<\/div>/);
    assert.match(busy, /data-action="dialog-cancel" disabled>/);
    assert.match(busy, /data-action="dialog-save" disabled>Saving…<\/button>/);
    assert.match(busy, /value="auto" checked/);

    app.state.settings = settingsFixture({ repoName: undefined });
    assert.match(app.run("dialogHtml()"), /Settings for this repository\./);
});

test("the Configure dialog opens on the saved mode, keeps the page inert behind it, traps Tab, and closes on Escape", async () => {
    const app = await loadApp();
    let prevented = 0;
    const press = (event: { key?: string; shiftKey?: boolean }) => app.run("onKeyDown")({ preventDefault: () => prevented++, ...event });
    app.state.review = reviewFixture();

    app.state.settings = null;
    app.run("openConfigure()");
    assert.equal(app.state.dialog, null, "there is nothing to configure until the server reports the settings");
    app.state.settings = settingsFixture({ learning: "auto", configured: true });

    app.run("openConfigure()");
    assert.equal(dialog(app).learning, "auto");
    assert.match(app.node("#dialog").innerHTML, /value="auto" checked/);
    for (const id of ["#top", "#banner", "#layout"]) assert.equal(app.node(id).inert, true, id);
    assert.equal(app.focused.at(-1), '#dialog input[name="learning"]:checked');
    const opened = app.state.dialog;
    app.run("openConfigure()");
    assert.equal(app.state.dialog, opened, "opening twice keeps the first dialog");

    await app.run("onChange")({ target: { name: "learning", value: "off" } });
    assert.equal(dialog(app).learning, "off");
    assert.equal(app.state.settings.learning, "auto", "the choice is only a draft until Save");

    const focus: string[] = [];
    const radios: MockFocusable[] = [
        Object.assign(new MockElement("INPUT"), { checked: false, name: "learning" }),
        Object.assign(new MockElement("INPUT"), { checked: true, name: "learning", focus: () => focus.push("radio") }),
        Object.assign(new MockElement("INPUT"), { checked: false, name: "learning" }),
    ];
    const buttons: MockFocusable[] = [
        Object.assign(new MockElement("BUTTON"), { focus: () => focus.push("cancel") }),
        Object.assign(new MockElement("BUTTON"), { focus: () => focus.push("save") }),
    ];
    app.document.querySelectorAll = (selector: string) => (selector.startsWith("#dialog input") ? radios : buttons);
    app.document.activeElement = buttons[1];
    press({ key: "Tab", shiftKey: false });
    app.document.activeElement = radios[1];
    press({ key: "Tab", shiftKey: true });
    app.document.activeElement = buttons[0];
    press({ key: "Tab", shiftKey: false });
    assert.deepEqual(focus, ["radio", "save"], "Tab wraps from the last stop to the first, and Shift+Tab from the first to the last");
    assert.equal(prevented, 2, "Tab between the stops is left to the browser");

    press({ key: "Escape" });
    assert.equal(app.state.dialog, null);
    assert.equal(prevented, 3);
    assert.equal(app.node("#dialog").innerHTML, "");
    for (const id of ["#top", "#banner", "#layout"]) assert.equal(app.node(id).inert, false, id);
    assert.equal(app.focused.at(-1), '[data-action="configure"]', "focus returns to the button that opened the dialog");

    app.run("openConfigure()");
    dialog(app).saving = true;
    press({ key: "Escape" });
    assert.notEqual(app.state.dialog, null, "a save in flight cannot be dismissed");
});

test("choosing a mode from the banner or the Configure dialog saves it, updates the controls, and reports a failed save", async () => {
    const posts: CapturedPost[] = [];
    let settings: ReturnType<typeof settingsFixture> | undefined = settingsFixture();
    let failure: string | null = null;
    const fetch = async (url: string, init?: { method?: string; body?: string }) => {
        const body = requestBody(init);
        posts.push([init?.method ?? "", url, body]);
        if (failure) return jsonResponse({ error: { message: failure } }, 500);
        settings = {
            ...(settings ?? settingsFixture()),
            ...(typeof body.learning === "string" ? { learning: body.learning, configured: true } : {}),
            ...(typeof body.delivery === "string" ? { delivery: body.delivery } : {}),
            ...(body.dismissed === true ? { dismissed: true } : {}),
        };
        return jsonResponse(settings);
    };
    const app = await loadApp({ fetch });
    const click = clicker(app);
    app.state.review = reviewFixture();
    app.state.settings = settings;
    app.run("renderBanner()");
    assert.equal(app.node("#banner").hidden, false);

    await click("learning-set", { mode: "suggest" });
    assert.deepEqual(posts.at(-1), ["POST", "/api/settings", { learning: "suggest" }]);
    assert.equal(app.state.settings.learning, "suggest");
    assert.equal(app.node("#banner").hidden, true, "choosing a mode settles the question");
    assert.match(app.node("#top").innerHTML, /Learning: Suggest/);
    assert.equal(app.node("#toast").textContent, "Learning mode: Suggest");

    settings = settingsFixture();
    app.state.settings = settings;
    await click("learning-dismiss");
    assert.deepEqual(posts.at(-1), ["POST", "/api/settings", { dismissed: true }]);
    assert.equal(app.node("#banner").hidden, true);
    assert.equal(app.state.settings.configured, false, "Not now leaves the repository unconfigured");
    assert.match(app.node("#top").innerHTML, /Learning: Off/);

    await click("configure");
    assert.equal(dialog(app).learning, "off");
    assert.equal(dialog(app).delivery, "immediate");
    await app.run("onChange")({ target: { name: "learning", value: "auto" } });
    await app.run("onChange")({ target: { name: "delivery", value: "batch" } });
    await click("dialog-save");
    assert.deepEqual(posts.at(-1), ["POST", "/api/settings", { learning: "auto", delivery: "batch" }]);
    assert.equal(app.state.dialog, null);
    assert.equal(app.state.settings.learning, "auto");
    assert.equal(app.state.settings.delivery, "batch");
    assert.equal(app.node("#dialog").innerHTML, "");
    assert.match(app.node("#top").innerHTML, /Delivery: Batch<\/span>.*Learning: Auto-save/);
    assert.equal(app.node("#toast").textContent, "Saved. Learning: Auto-save · Delivery: Batch");
    assert.equal(app.focused.at(-1), '[data-action="configure"]');

    await click("configure");
    failure = "disk full";
    await app.run("onChange")({ target: { name: "learning", value: "off" } });
    await click("dialog-save");
    assert.equal(dialog(app).saving, false);
    assert.equal(dialog(app).error, "disk full");
    assert.equal(app.state.settings.learning, "auto", "a failed save changes nothing");
    assert.match(app.node("#dialog").innerHTML, /role="alert">disk full</);
    assert.equal(app.focused.at(-1), '#dialog [data-action="dialog-save"]');
    failure = null;
    await click("dialog-save");
    assert.equal(app.state.dialog, null, "retrying after the failure succeeds");
    assert.equal(app.state.settings.learning, "off");

    failure = "offline";
    await click("learning-set", { mode: "auto" });
    assert.equal(app.state.settings.learning, "off");
    assert.equal(app.node("#toast").textContent, "offline");
    assert.equal(app.node("#toast").className, "error");
});

test("the Configure dialog closes from Cancel or a click on the backdrop, but not from a click inside it or while saving", async () => {
    const app = await loadApp();
    const click = clicker(app);
    app.state.review = reviewFixture();
    app.state.settings = settingsFixture({ configured: true });

    await click("configure");
    const backdrop = Object.assign(new MockElement("DIV"), { dataset: { action: "dialog-backdrop" } });
    backdrop.closest = () => backdrop;
    await app.run("onClick")({ target: { closest: () => backdrop } });
    assert.notEqual(app.state.dialog, null, "a click that landed inside the dialog does not close it");
    await app.run("onClick")({ target: backdrop });
    assert.equal(app.state.dialog, null);

    await click("configure");
    dialog(app).saving = true;
    await click("dialog-cancel");
    assert.notEqual(app.state.dialog, null);
    dialog(app).saving = false;
    await click("dialog-cancel");
    assert.equal(app.state.dialog, null);
});

test("lessons show their status next to each rule in the thread and in the Lessons learned table", async () => {
    const app = await loadApp();
    app.state.review = reviewFixture({
        lessons: [
            { lessonId: "l-1", threadId: "t1", scope: "repo", rule: "Prefer `ILogger`", savedTo: "AGENTS.md", createdAt: "2026-01-01T00:00:00Z" },
            { lessonId: "l-2", threadId: "t1", scope: "personal", rule: "Keep <b>short</b>", status: "proposed", savedTo: null, createdAt: "2026-01-02T00:00:00Z" },
            { lessonId: "l-3", threadId: "t2", scope: "repo", rule: "Avoid globals", status: "declined", savedTo: null, createdAt: "2026-01-03T00:00:00Z" },
            { lessonId: "l-4", threadId: "t2", scope: "repo", rule: "Unknown status", status: "bogus", savedTo: null, createdAt: "2026-01-04T00:00:00Z" },
        ],
    });
    const message = (lessonIds: string[]) => app.run(`messageHtml(${JSON.stringify({ messageId: "m", author: "agent", body: "Done", outcome: "fixed", createdAt: "2026-01-02T00:00:00Z", lessonIds })})`);

    const html = message(["l-1", "l-2", "missing"]);
    assert.match(html, /<li><span class="badge">repo<\/span> <span class="badge lesson-saved"[^>]*>saved<\/span> Prefer <code>ILogger<\/code> <span class="muted mono">→ AGENTS\.md<\/span><\/li>/, "a lesson recorded before statuses existed was saved");
    assert.match(html, /<li><span class="badge">personal<\/span> <span class="badge lesson-proposed"[^>]*>proposed<\/span> Keep &lt;b&gt;short&lt;\/b&gt;<\/li>/, "a proposed lesson is not saved anywhere yet");
    assert.equal(required(html.match(/<li>/g)).length, 2, "an unknown lesson id is skipped");
    assert.doesNotMatch(message([]), /Guidelines:/);

    const table = app.run("lessonsView()");
    assert.match(table, /<h2>Lessons learned \(4\)<\/h2>/);
    assert.match(table, /<th>Scope<\/th><th>Status<\/th><th>Rule<\/th><th>Saved to<\/th>/);
    assert.deepEqual([...table.matchAll(/badge lesson-(\w+)"/g)].map((m) => m[1]), ["saved", "declined", "proposed", "saved"], "newest first, and an unknown status reads as saved");
    assert.match(table, /<td class="mono muted">AGENTS\.md<\/td>/);
    assert.match(table, /Keep &lt;b&gt;short&lt;\/b&gt;/);
});

test("the empty Lessons learned view explains what the current learning mode does", async () => {
    const app = await loadApp();
    app.state.review = reviewFixture();
    const empty = (settings: RuntimeState["settings"]) => {
        app.state.settings = settings;
        return app.run("lessonsView()");
    };
    assert.match(empty(null), /^<h2>Lessons learned<\/h2><div class="empty">Copilot records reusable rules here/);
    assert.match(empty(settingsFixture({ learning: "suggest" })), /Copilot proposes reusable guidelines here.*saves one after you approve it/);
    assert.match(empty(settingsFixture({ learning: "auto" })), /Copilot saves reusable guidelines here/);
    for (const learning of ["off", "unexpected"]) assert.match(empty(settingsFixture({ learning })), /Learning is off for this repository.*Use Configure to turn it on/, learning);
});

test("an empty diff explains itself per scope, and only the pending scope offers the way back", async () => {
    const app = await loadApp();
    const empty = () => app.run("emptyDiffHtml()");
    app.state.review = reviewFixture({ scope: "pending", base: "origin/<main>" });
    assert.equal(empty(), "", "nothing is claimed before the snapshot loads");
    app.state.snapshot = { files: [{ path: "a.cs", hunks: [], additions: 1, deletions: 0 }] };
    assert.equal(empty(), "");

    app.state.snapshot = { files: [] };
    assert.match(empty(), /<strong>No uncommitted changes\.<\/strong>/);
    assert.match(empty(), /<button data-action="scope" data-scope="all">Switch to All changes<\/button>/);
    assert.match(app.run("overviewView()"), /^<div class="card empty-diff">/);
    app.run("renderSide()");
    assert.match(app.node("#side").innerHTML, /No uncommitted changes\./);

    for (const scope of ["all", undefined]) {
        app.state.review = reviewFixture({ scope, base: "origin/<main>" });
        const html = empty();
        assert.match(html, /<strong>No changes to review\.<\/strong> Nothing differs from origin\/&lt;main&gt;\./);
        assert.doesNotMatch(html, /<button/);
        app.run("renderSide()");
        assert.match(app.node("#side").innerHTML, /No changes against the base\./);
    }
});

test("switching scope loads the other review, remembers each review's own view, and never sticks in the switching state", async () => {
    const calls: string[] = [];
    const reviews: Record<string, ReturnType<typeof reviewFixture>> = {
        a: reviewFixture({ reviewId: "a", currentRevisionId: "ra" }),
        b: reviewFixture({ reviewId: "b", currentRevisionId: "rb", scope: "pending" }),
    };
    let current = "a";
    let failure: string | null = null;
    let settings: ReturnType<typeof settingsFixture> | undefined = settingsFixture({ configured: true });
    const fetch = async (url: string, init?: { method?: string; body?: string }) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url === "/api/state") return jsonResponse({ review: reviews[current], session: { busy: false }, settings });
        if (url.startsWith("/api/snapshot/")) return jsonResponse({ revisionId: url.split("/").pop(), files: [] });
        if (url === "/api/scope") {
            if (failure) return jsonResponse({ error: { message: failure } }, 500);
            current = requestBody(init).scope === "pending" ? "b" : "a";
            return jsonResponse({ reviewId: current });
        }
        throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
    };
    const app = await loadApp({ fetch });
    const click = clicker(app);
    app.run("render = () => {}; var switchingSeen = []; renderTop = () => { switchingSeen.push(state.switching); };");

    await app.run("loadState()");
    assert.equal(app.state.review.reviewId, "a");
    assert.equal(required(app.state.snapshot).revisionId, "ra");

    app.run('navigate({ type: "file", path: "src/a.cs" })');
    app.run('state.open.add("line:src/a.cs:new:5-5"); state.expanded.add("t1"); state.fileFold.set("src/a.cs", true); state.content.set("ra:src/a.cs", {}); state.pendingJump = "t1"; collapsedDirs();');
    app.sessionStorage.items.set("sr:b:view", JSON.stringify({ type: "lessons" }));

    await click("scope", { scope: "pending" });
    assert.deepEqual(calls.slice(-3), ["POST /api/scope", "GET /api/state", "GET /api/snapshot/rb"]);
    assert.equal(app.state.review.reviewId, "b");
    assert.equal(required(app.state.snapshot).revisionId, "rb");
    assert.deepEqual(app.read("state.view"), { type: "lessons" }, "the other review restores its own view instead of inheriting this one");
    assert.deepEqual(app.read("[state.open.size, state.pending.size, state.expanded.size, state.fileFold.size, state.content.size]"), [0, 0, 0, 0, 0]);
    assert.equal(app.read("state.collapsedDirs"), null);
    assert.equal(app.read("state.pendingJump"), null);
    assert.equal(app.state.switching, false);

    const before = calls.length;
    await click("scope", { scope: "pending" });
    assert.equal(calls.length, before, "choosing the active scope does nothing");

    await app.run("loadState()");
    assert.deepEqual(calls.slice(before), ["GET /api/state"], "a refresh of the same review does not reload the snapshot");
    assert.deepEqual(app.read("state.view"), { type: "lessons" }, "and keeps the view");

    await click("scope", { scope: "all" });
    assert.equal(app.state.review.reviewId, "a");
    assert.deepEqual(app.read("state.view"), { type: "file", path: "src/a.cs" }, "switching back returns to where this review was left");

    failure = "boom";
    await click("scope", { scope: "pending" });
    assert.equal(app.state.review.reviewId, "a", "a failed switch stays on the current review");
    assert.equal(app.state.switching, false);
    assert.equal(app.node("#toast").textContent, "boom");
    assert.equal(app.node("#toast").className, "error");
    assert.deepEqual(app.read("switchingSeen"), [true, false, true, false, true, false]);

    settings = undefined;
    await app.run("loadState()");
    assert.equal(app.state.settings, null, "a server without settings hides the learning controls");
});

const userMessage = (messageId: string, state: string) => ({ messageId, author: "user", body: messageId, createdAt: "2026-01-01", delivery: { state } });
const draftThreads = () => [
    { threadId: "t1", kind: "overview", status: "active", messages: [userMessage("m1", "draft"), { messageId: "a1", author: "agent", body: "ok", createdAt: "2026-01-01" }, userMessage("m2", "draft")] },
    { threadId: "t2", kind: "overview", status: "active", messages: [userMessage("m3", "queued")] },
];

test("the top bar offers Submit review while drafts wait, and shows how comments reach Copilot", async () => {
    const app = await loadApp();
    const top = () => {
        app.run("renderTop()");
        return app.node("#top").innerHTML;
    };
    app.state.settings = settingsFixture({ configured: true });
    app.state.review = reviewFixture({ threads: draftThreads() });

    let html = top();
    assert.match(html, /<button class="primary" data-action="submit-review"[^>]*>Submit review \(2\)<\/button>/, "agent replies and delivered comments are not drafts");
    app.state.submitting = true;
    html = top();
    assert.match(html, /data-action="submit-review"[^>]* disabled>Submitting…<\/button>/);
    assert.doesNotMatch(html, /Submit review \(/);
    app.state.submitting = false;
    app.state.review = reviewFixture({ threads: [draftThreads()[1]] });
    assert.doesNotMatch(top(), /submit-review/, "nothing to submit without drafts");

    for (const [delivery, deliveryMode, pill, reask] of [
        ["immediate", undefined, "Immediate", false],
        ["batch", "immediate", "Batch", false],
        ["ask", undefined, "Ask", false],
        ["ask", "batch", "Batch", true],
        ["ask", "immediate", "Immediate", true],
        ["unexpected", undefined, "Immediate", false],
    ]) {
        app.state.settings = settingsFixture({ configured: true, delivery });
        app.state.review = reviewFixture({ deliveryMode });
        html = top();
        assert.match(html, new RegExp(`Delivery: ${pill}</span>`), `${delivery}/${deliveryMode}`);
        assert.equal(/data-action="delivery-reask"[^>]*>Change</.test(html), reask, `only a decided ask-mode review offers Change (${delivery}/${deliveryMode})`);
    }
    app.state.settings = null;
    app.state.review = reviewFixture({ threads: draftThreads() });
    html = top();
    assert.doesNotMatch(html, /Delivery:/);
    assert.match(html, /Submit review \(2\)/, "a comment held on request can still be submitted without settings");
});

test("an ask-mode review asks how to send comments until the reviewer chooses", async () => {
    const app = await loadApp();
    const banner = (settings: RuntimeState["settings"], review: RuntimeState["review"] | null) => {
        app.state.settings = settings;
        if (review) app.state.review = review;
        else app.run("state.review = null");
        app.run("renderBanner()");
        return app.node("#banner");
    };
    const ask = settingsFixture({ configured: true, delivery: "ask" });

    const shown = banner(ask, reviewFixture());
    assert.equal(shown.hidden, false);
    assert.match(shown.innerHTML, /How should Copilot receive your comments on this review\?/);
    assert.match(shown.innerHTML, /Until you choose, new comments wait as drafts\./);
    assert.match(shown.innerHTML, /data-action="delivery-choose" data-mode="immediate"[^>]*>Send each now</);
    assert.match(shown.innerHTML, /data-action="delivery-choose" data-mode="batch"[^>]*>Batch into a review</);
    assert.match(banner(ask, reviewFixture({ threads: [draftThreads()[1], { threadId: "t3", messages: [userMessage("m4", "draft")] }] })).innerHTML, /1 draft comment is waiting\./);
    assert.match(banner(ask, reviewFixture({ threads: draftThreads() })).innerHTML, /2 draft comments are waiting\./);

    assert.equal(banner(ask, reviewFixture({ deliveryMode: "batch" })).hidden, true, "a decided review is not asked again");
    assert.equal(banner(ask, reviewFixture({ deliveryMode: "immediate" })).hidden, true);
    assert.equal(banner(settingsFixture({ configured: true, delivery: "batch" }), reviewFixture()).hidden, true);
    assert.equal(banner(null, reviewFixture()).hidden, true);
    assert.equal(banner(ask, null).hidden, true);

    const both = banner(settingsFixture({ delivery: "ask" }), reviewFixture());
    assert.equal(required(both.innerHTML.match(/class="banner-row"/g)).length, 2, "the learning and delivery questions can show together");
});

test("the composer and the draft badge follow the delivery mode", async () => {
    const app = await loadApp();
    const composer = () => app.run(`composerHtml("file:a.cs", { kind: "file", path: "a.cs" })`);
    const setMode = (delivery: string | null, deliveryMode?: string) => {
        app.state.settings = delivery ? settingsFixture({ configured: true, delivery }) : null;
        app.state.review = reviewFixture({ deliveryMode });
    };

    const composerModes: Array<[string | null, string | undefined, boolean, boolean | null]> = [
        [null, undefined, false, null],
        ["immediate", undefined, false, null],
        ["ask", "immediate", false, null],
        ["batch", undefined, true, true],
        ["ask", undefined, true, true],
        ["ask", "batch", true, true],
    ];
    for (const [delivery, deliveryMode, batching, defaultDraft] of composerModes) {
        const label = `${delivery}/${deliveryMode}`;
        setMode(delivery, deliveryMode);
        const html = composer();
        assert.equal(app.read("defaultDraft() ?? null"), defaultDraft, `immediate lets the server decide; otherwise the composer holds (${label})`);
        if (batching) {
            assert.match(html, /<button data-action="submit" data-key="file:a.cs" data-draft="0"[^>]*>Send now<\/button>/, label);
            assert.match(html, /<button class="primary" data-action="submit" data-key="file:a.cs" data-draft="1"[^>]*>Add to review<\/button>/, label);
            assert.match(html, /Ctrl\+Enter to add to review/, label);
        } else {
            assert.match(html, /<button class="primary" data-action="submit" data-key="file:a.cs" >Comment<\/button>/, label);
            assert.doesNotMatch(html, /data-draft=|Add to review/, label);
            assert.match(html, /Ctrl\+Enter to send/, label);
        }
    }

    setMode("batch");
    app.run(`state.pending.set("file:a.cs", { sending: true })`);
    assert.match(composer(), /data-draft="0" title="[^"]*" disabled>Send now<\/button><button class="primary" [^>]*data-draft="1" title="[^"]*" disabled>Saving…<\/button>/);

    const badge = app.run(`deliveryHtml(${JSON.stringify(userMessage('m"1', "draft"))})`);
    assert.match(badge, /^<span class="delivery draft" title="Held until you submit the review">Draft · /);
    assert.match(badge, /<button class="link" data-action="send-draft" data-message="m&quot;1">Send now<\/button>/);
    assert.match(badge, /<button class="link" data-action="discard-draft" data-message="m&quot;1">Discard<\/button>/);
});

test("posting a comment sends the draft flag the clicked button chose, or lets the server decide", async () => {
    const posts: CapturedPost[] = [];
    let settings = settingsFixture({ configured: true, delivery: "batch" });
    const fetch = async (url: string, init?: { method?: string; body?: string }) => {
        if (url === "/api/state") return jsonResponse({ review: reviewFixture(), session: { busy: false }, settings });
        if (url.startsWith("/api/snapshot/")) return jsonResponse({ revisionId: "r1", files: [] });
        posts.push([url, requestBody(init)]);
        return jsonResponse({ threadId: "t9", messageId: "m9", duplicate: false, draft: true });
    };
    const app = await loadApp({ fetch, CSS: { escape: (s: string) => s } });
    const click = clicker(app);
    app.run("render = () => {};");
    const box = (key: string, dataset: Record<string, string>) => {
        Object.assign(app.node(`.composer[data-key="${key}"]`), { dataset, querySelector: () => ({ value: " Rename this ", focus() {} }) });
    };
    box("file:a.cs", { kind: "file", path: "a.cs" });
    box("reply:t1", {});
    Object.assign(app.node('[data-thread-id="t9"]'), { classList: { add() {}, remove() {} } });
    await app.run("loadState()");

    const sent = async (dataset: Record<string, string>) => {
        await click("submit", dataset);
        const [url] = required(posts.at(-1));
        const body = capturedBody(posts);
        return [url, body.body, Object.hasOwn(body, "draft") ? body.draft : "server decides"];
    };
    assert.deepEqual(await sent({ key: "file:a.cs", draft: "1" }), ["/api/threads", "Rename this", true]);
    assert.deepEqual(await sent({ key: "file:a.cs", draft: "0" }), ["/api/threads", "Rename this", false]);
    assert.deepEqual(await sent({ key: "reply:t1", draft: "1" }), ["/api/threads/t1/messages", "Rename this", true]);
    assert.deepEqual(await sent({ key: "file:a.cs" }), ["/api/threads", "Rename this", true], "Ctrl+Enter in batch mode adds to the review");

    settings = settingsFixture({ configured: true, delivery: "immediate" });
    await app.run("loadState()");
    assert.deepEqual(await sent({ key: "reply:t1" }), ["/api/threads/t1/messages", "Rename this", "server decides"]);
    assert.equal(app.read("state.pending.size"), 0, "every post completed");
});

test("Send now, Discard, Submit review and the delivery question call the server and report the outcome", async () => {
    const calls: string[] = [];
    const replies = new Map();
    const fetch = async (url: string, init?: { method?: string; body?: string }) => {
        if (url === "/api/state") {
            calls.push("GET /api/state");
            return jsonResponse({ review: reviewFixture({ threads: draftThreads() }), session: { busy: false }, settings: settingsFixture({ configured: true, delivery: "ask" }) });
        }
        if (url.startsWith("/api/snapshot/")) return jsonResponse({ revisionId: "r1", files: [] });
        calls.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`);
        const reply = replies.get(url);
        if (!reply) throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
        return typeof reply === "function" ? reply() : reply;
    };
    const app = await loadApp({ fetch });
    const click = clicker(app);
    app.run("render = () => {}; var submittingSeen = []; renderTop = () => { submittingSeen.push(state.submitting); };");
    const toast = () => [app.node("#toast").textContent, app.node("#toast").className === "error"];
    const act = async (action: string, dataset: Record<string, string> = {}) => {
        const before = calls.length;
        await click(action, dataset);
        return calls.slice(before);
    };

    replies.set("/api/messages/m%3A1/send", jsonResponse({ delivered: true, sessionMessageId: "sm-1" }));
    assert.deepEqual(await act("send-draft", { message: "m:1" }), ["POST /api/messages/m%3A1/send {}", "GET /api/state"]);
    assert.deepEqual(toast(), ["Sent to Copilot", false]);
    replies.set("/api/messages/m%3A1/send", jsonResponse({ delivered: false, error: "session closed" }));
    await act("send-draft", { message: "m:1" });
    assert.deepEqual(toast(), ["session closed", true]);

    replies.set("/api/messages/m1/discard", jsonResponse({ threadId: "t1", threadRemoved: false }));
    assert.deepEqual(await act("discard-draft", { message: "m1" }), ["POST /api/messages/m1/discard {}", "GET /api/state"]);
    assert.deepEqual(toast(), ["Draft discarded", false]);

    for (const [submitted, text] of [[3, "Sent 3 comments to Copilot"], [1, "Sent 1 comment to Copilot"]]) {
        replies.set("/api/submit", jsonResponse({ submitted, delivered: true, sessionMessageId: "sm-2" }));
        assert.deepEqual(await act("submit-review"), ["POST /api/submit {}", "GET /api/state"]);
        assert.deepEqual(toast(), [text, false]);
    }
    assert.deepEqual(app.read("submittingSeen"), [true, true], "the button shows Submitting while the request is in flight");
    assert.equal(app.state.submitting, false);
    replies.set("/api/submit", jsonResponse({ submitted: 2, delivered: false, error: "session closed" }));
    await act("submit-review");
    assert.deepEqual(toast(), ["session closed", true]);
    replies.set("/api/submit", jsonResponse({ error: { message: "disk full" } }, 500));
    assert.deepEqual(await act("submit-review"), ["POST /api/submit {}", "GET /api/state"], "the review is reloaded even when the submission fails");
    assert.deepEqual(toast(), ["disk full", true]);
    assert.equal(app.state.submitting, false, "a failed submission never sticks in the submitting state");
    app.state.submitting = true;
    assert.deepEqual(await act("submit-review"), [], "a second click while submitting does nothing");
    app.state.submitting = false;

    const deliveryOutcomes: Array<[string, number, string]> = [
        ["immediate", 2, "Sending each comment now. Sent 2 waiting drafts."],
        ["immediate", 1, "Sending each comment now. Sent 1 waiting draft."],
        ["immediate", 0, "Sending each comment now"],
        ["batch", 0, "Batching comments. Submit the review when you are done."],
    ];
    for (const [mode, submitted, text] of deliveryOutcomes) {
        replies.set("/api/delivery", jsonResponse({ mode, submitted }));
        assert.deepEqual(await act("delivery-choose", { mode }), [`POST /api/delivery {"mode":"${mode}"}`, "GET /api/state"]);
        assert.deepEqual(toast(), [text, false], `${mode} ${submitted}`);
    }
    replies.set("/api/delivery", jsonResponse({ mode: "immediate", submitted: 2, error: "session closed" }));
    await act("delivery-choose", { mode: "immediate" });
    assert.deepEqual(toast(), ["Sending each comment now, but 2 waiting drafts could not be sent: session closed", true]);
    replies.set("/api/delivery", jsonResponse({ mode: null, submitted: 0 }));
    assert.deepEqual(await act("delivery-reask"), ['POST /api/delivery {"mode":null}', "GET /api/state"]);
});
