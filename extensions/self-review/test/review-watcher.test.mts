import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Delivery, ReviewService, ReviewWatcher, Store, runGit, startReviewServer } from "./modules.mjs";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 10000;
    while (!await predicate()) {
        if (Date.now() > deadline) throw new Error("Automatic refresh did not arrive.");
        await delay(25);
    }
}

async function fixture(t: TestContext) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "sr-watch-"));
    const repo = path.join(tmp, "repo");
    const git = (...args: string[]) => runGit(repo, ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false", ...args]);
    await runGit(tmp, ["init", "-q", "-b", "main", repo]);
    await writeFile(path.join(repo, "file.ts"), "base\n");
    await writeFile(path.join(repo, ".gitignore"), "node_modules/\nbuild/\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    const service = new ReviewService({ store: new Store(path.join(tmp, "data")) });
    const id = await service.ensureReview({ repoPath: repo, scope: "pending", exclude: ["excluded.ts"] });
    let refreshes = 0;
    const logs: string[] = [];
    const watcher = new ReviewWatcher({
        getReview: (id) => service.getReview(id),
        refresh: async (id) => { refreshes++; return service.refresh(id); },
    }, (text) => logs.push(text), 100);
    t.after(async () => { await watcher.close(); await rm(tmp, { recursive: true, force: true }); });
    return { tmp, repo, git, service, id, watcher, logs, count: () => refreshes };
}

test("debounce waits for the last event and releases every watcher and pending timer on close", async (t) => {
    const f = await fixture(t);
    const sources = new Map<string, { change: (file: string | null) => void; fail: (error: Error) => void; closed: boolean }>();
    let calls = 0;
    let notify = () => {};
    const watcher = new ReviewWatcher({
        getReview: (id) => f.service.getReview(id),
        refresh: async () => { calls++; notify(); return { revisionId: "r1", created: false, moved: 0 }; },
    }, (text) => f.logs.push(text), 100, (root, change, fail) => {
        const source = { change, fail, closed: false };
        sources.set(root, source);
        return { close: () => { source.closed = true; } };
    });
    t.after(() => watcher.close());
    await watcher.setReview(f.id);
    const source = sources.get(f.repo);
    assert.ok(source);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    source.change("file.ts");
    t.mock.timers.tick(99);
    source.change("file.ts");
    t.mock.timers.tick(99);
    assert.equal(calls, 1, "no refresh before the quiet interval");
    const refreshed = new Promise<void>((resolve) => { notify = resolve; });
    t.mock.timers.tick(1);
    await refreshed;
    assert.equal(calls, 2, "the burst produces exactly one refresh");
    await writeFile(path.join(f.repo, "file.ts"), "changed during continuous watcher noise\n");
    const boundedRefresh = new Promise<void>((resolve) => { notify = resolve; });
    source.change("file.ts");
    for (let i = 0; i < 15; i++) {
        t.mock.timers.tick(100);
        source.change("ignored-output.log");
    }
    await boundedRefresh;
    assert.equal(calls, 3, "continuous events cannot postpone a relevant refresh beyond the maximum wait");
    source.fail(new Error("watch failed"));
    assert.ok(source.closed);
    assert.match(f.logs[0] ?? "", /watch failed.*Manual Refresh remains available/);
    source.change("file.ts");
    await watcher.close();
    t.mock.timers.tick(500);
    assert.equal(calls, 3, "close cancels the queued refresh");
    assert.ok([...sources.values()].every((entry) => entry.closed));
});

test("checkout edits preserve review options and ignore output and Git noise", async (t) => {
    const f = await fixture(t);
    await f.watcher.setReview(f.id);
    for (let i = 0; i < 5; i++) await writeFile(path.join(f.repo, "file.ts"), `changed ${i}\n`);
    await until(async () => (await f.service.getReview(f.id)).currentRevisionId === "r2");
    await delay(400);
    const review = await f.service.getReview(f.id);
    assert.equal(review.currentRevisionId, "r2");
    assert.equal(review.scope, "pending");
    assert.deepEqual(review.exclude, ["excluded.ts"]);
    assert.equal(review.base, null);
    await mkdir(path.join(f.repo, "node_modules"), { recursive: true });
    await writeFile(path.join(f.repo, "node_modules", "output.js"), "ignored\n");
    await writeFile(path.join(f.repo, ".git", "index.lock"), "noise\n");
    await delay(500);
    assert.equal((await f.service.getReview(f.id)).currentRevisionId, "r2", "ignored output and lock files do not create a revision");
    await mkdir(path.join(f.repo, "nested"));
    await writeFile(path.join(f.repo, "nested", "new.ts"), "new\n");
    await until(async () => (await f.service.getSnapshot(f.id)).files.some((file) => file.path === "nested/new.ts"));
    await rm(path.join(f.repo, "nested", "new.ts"));
    await until(async () => !(await f.service.getSnapshot(f.id)).files.some((file) => file.path === "nested/new.ts"));
    assert.deepEqual(f.logs, []);
});

test("unnamed events always refresh and directory replacement does not discard a debounce batch", async (t) => {
    const f = await fixture(t);
    await mkdir(path.join(f.repo, "dir"));
    await writeFile(path.join(f.repo, "dir", "file.ts"), "tracked\n");
    await f.git("add", "dir");
    const sources = new Map<string, (file: string | null) => void>();
    let calls = 0;
    const watcher = new ReviewWatcher({
        getReview: (id) => f.service.getReview(id),
        refresh: async () => { calls++; return { revisionId: "r1", created: false, moved: 0 }; },
    }, (text) => f.logs.push(text), 10, (root, change) => {
        sources.set(root, change);
        return { close() {} };
    });
    t.after(() => watcher.close());
    await watcher.setReview(f.id);
    const checkout = sources.get(f.repo);
    const metadata = [...sources].find(([root]) => root !== f.repo)?.[1];
    assert.ok(checkout);
    assert.ok(metadata);
    for (const source of [checkout, metadata, checkout, metadata]) {
        const before = calls;
        source(null);
        await until(() => calls > before);
    }
    await rm(path.join(f.repo, "dir"), { recursive: true });
    await writeFile(path.join(f.repo, "dir"), "directory replaced with a file\n");
    const before = calls;
    checkout("dir/file.ts");
    checkout("dir");
    checkout("file.ts");
    await until(() => calls > before);
    assert.deepEqual(f.logs, []);
});

test("submodule working files and stored HEAD metadata trigger superproject refreshes", async (t) => {
    const f = await fixture(t);
    const source = path.join(f.tmp, "submodule-source");
    await runGit(f.tmp, ["init", "-q", "-b", "main", source]);
    await writeFile(path.join(source, "nested.ts"), "base\n");
    await writeFile(path.join(source, ".gitignore"), "node_modules/\n");
    await runGit(source, ["add", "."]);
    await runGit(source, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "base"]);
    await f.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "vendor/lib");
    await f.git("commit", "-qam", "submodule");
    await f.watcher.setReview(f.id);
    const submodule = path.join(f.repo, "vendor", "lib");
    const beforeTracked = f.count();
    await writeFile(path.join(submodule, "nested.ts"), "dirty\n");
    await until(async () => (await f.service.getSnapshot(f.id)).files.some((file) => file.path === "vendor/lib"));
    await until(() => f.count() > beforeTracked);
    const afterTrackedEdit = f.count();
    await mkdir(path.join(submodule, "node_modules"));
    await writeFile(path.join(submodule, "node_modules", "output.js"), "ignored\n");
    assert.equal((await runGit(submodule, ["check-ignore", "node_modules/output.js"])).stdout.trim(), "node_modules/output.js");
    assert.ok(!(await runGit(submodule, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).stdout.includes("node_modules/output.js"));
    await delay(1800);
    assert.equal(f.count(), afterTrackedEdit, "ignored submodule output does not trigger a superproject refresh");
    const beforeUntracked = f.count();
    const untracked = path.join(submodule, "new.ts");
    await writeFile(untracked, "untracked review content\n");
    await until(() => f.count() > beforeUntracked);
    const beforeDelete = f.count();
    await rm(untracked);
    await until(() => f.count() > beforeDelete);
    const before = f.count();
    await runGit(submodule, ["add", "."]);
    await runGit(submodule, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "updated"]);
    await until(() => f.count() > before);
    await delay(400);
    const after = f.count();
    const head = await runGit(submodule, ["rev-parse", "HEAD"]);
    await runGit(submodule, ["update-ref", "refs/heads/main", `${head.stdout.trim()}^`]);
    await until(() => f.count() > after);
    assert.deepEqual(f.logs, []);
});

test("HEAD/index changes in linked worktrees and shared base refs refresh; close cancels queued work", async (t) => {
    const f = await fixture(t);
    const linked = path.join(f.tmp, "linked");
    await f.git("worktree", "add", "-qb", "feature", linked);
    const id = await f.service.ensureReview({ repoPath: linked, base: "main" });
    await f.watcher.setReview(id);
    const initial = f.count();
    await writeFile(path.join(linked, "file.ts"), "feature\n");
    await until(() => f.count() > initial);
    await runGit(linked, ["add", "file.ts"]);
    let count = f.count();
    await until(() => f.count() > count);
    count = f.count();
    await runGit(linked, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "feature"]);
    await until(async () => (await f.service.getReview(id)).git?.headCommit === (await runGit(linked, ["rev-parse", "HEAD"])).stdout.trim());
    assert.ok(f.count() > count);
    count = f.count();
    await f.git("update-ref", "refs/heads/main", (await runGit(linked, ["rev-parse", "HEAD"])).stdout.trim());
    await until(() => f.count() > count);
    await appendFile(path.join(linked, "file.ts"), "queued\n");
    await f.watcher.close();
    const closedCount = f.count();
    await appendFile(path.join(linked, "file.ts"), "after close\n");
    await delay(500);
    assert.equal(f.count(), closedCount);
    assert.deepEqual(f.logs, []);
});

test("switching reviews releases the former checkout and failed setup leaves manual refresh usable", async (t) => {
    const f = await fixture(t);
    await f.watcher.setReview(f.id);
    const other = path.join(f.tmp, "other");
    await f.git("worktree", "add", "-qb", "other", other);
    const otherId = await f.service.ensureReview({ repoPath: other, scope: "pending" });
    await f.watcher.setReview(otherId);
    const count = f.count();
    await writeFile(path.join(f.repo, "file.ts"), "no longer watched\n");
    await delay(400);
    assert.equal(f.count(), count);
    await writeFile(path.join(other, "file.ts"), "watched\n");
    await until(() => f.count() > count);
    await f.watcher.setReview("missing-review");
    assert.match(f.logs[0] ?? "", /automatic refresh unavailable.*Manual Refresh remains available/);
    assert.ok(await f.service.refresh(otherId));
});

test("an open server pushes checkout refreshes and closing the panel stops refreshes", async (t) => {
    const f = await fixture(t);
    const delivery = new Delivery({ service: f.service, send: async () => "unused", reviewIds: () => [f.id] });
    const server = await startReviewServer({
        instanceId: "watch-test", getReviewId: () => f.id, service: f.service, delivery,
        webRoot: fileURLToPath(new URL("../dist/web", import.meta.url)), findPullRequest: async () => null,
    });
    t.after(() => server.close());
    const url = new URL(server.url);
    const events = await fetch(new URL(`/api/events${url.search}`, url), { signal: AbortSignal.timeout(15000) });
    assert.ok(events.body);
    const reader = events.body.getReader();
    try {
        await reader.read(); // Initial hello establishes the live SSE connection.
        await writeFile(path.join(f.repo, "file.ts"), "automatically refreshed\n");
        const event = await reader.read();
        assert.match(new TextDecoder().decode(event.value), /event: changed/);
        const response = await fetch(new URL(`/api/state${url.search}`, url));
        const state = await response.json() as { review: { currentRevisionId: string } };
        assert.equal(state.review.currentRevisionId, "r2");
    } finally {
        await reader.cancel();
        await server.close();
    }
    const revision = (await f.service.getReview(f.id)).currentRevisionId;
    await writeFile(path.join(f.repo, "file.ts"), "after panel close\n");
    await delay(700);
    assert.equal((await f.service.getReview(f.id)).currentRevisionId, revision);
});
