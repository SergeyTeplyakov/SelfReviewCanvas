// Per-canvas-instance loopback HTTP server: static UI + JSON API + SSE change feed.
// Bound to 127.0.0.1 on an ephemeral port; every /api call needs the per-instance token,
// and POSTs need it as a header (cross-origin pages cannot set it without a preflight we never answer).
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "../web/contracts.mjs";
import { SCOPES } from "./review-service.mjs";
import { SUGGESTED_REVIEWERS } from "./agent-review.mjs";
import { resolveDelivery } from "./settings.mjs";
import { findOpenPullRequest } from "./pull-request.mjs";
import { SettingsHttp, HttpError } from "./settings-http.mjs";
import { ReviewWatcher } from "./review-watcher.mjs";
const MAX_JSON = 1024 * 1024;
const PULL_REQUEST_CACHE_MS = 30_000;
const STATIC = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/styles.css": ["styles.css", "text/css; charset=utf-8"],
    "/contracts.mjs": ["contracts.mjs", "text/javascript; charset=utf-8"],
    "/settings-api.mjs": ["settings-api.mjs", "text/javascript; charset=utf-8"],
};
const ASSET_FILES = [...new Set(Object.values(STATIC).map(([file]) => file))];
const ASSET_DEBOUNCE_MS = 250;
function send(res, status, body, type = "application/json; charset=utf-8") {
    const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    if (payload === undefined)
        throw new TypeError("Response body is not JSON serializable.");
    res.writeHead(status, {
        "Content-Type": type,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
    });
    res.end(payload);
}
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        const type = req.headers["content-type"] ?? "";
        if (typeof type !== "string" || !type.startsWith("application/json")) {
            reject(new HttpError(415, "invalid_input", "Expected application/json."));
            return;
        }
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_JSON) {
                reject(new HttpError(413, "invalid_input", "Request body too large."));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            try {
                resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
            }
            catch {
                reject(new HttpError(400, "invalid_input", "Malformed JSON."));
            }
        });
        req.on("error", reject);
    });
}
function tokenMatches(expected, provided) {
    if (typeof provided !== "string" || provided.length !== expected.length)
        return false;
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}
const STATUS_FOR_CODE = { invalid_input: 400, not_found: 404, conflict: 409, git_error: 502 };
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function recordBody(value) {
    if (!isRecord(value))
        throw new HttpError(400, "invalid_input", "Expected a JSON object.");
    return value;
}
function isReviewScope(value) {
    return typeof value === "string" && SCOPES.some((scope) => scope === value);
}
export async function startReviewServer({ instanceId, getReviewId, service, delivery, webRoot, log = () => { }, settings, onReviewChange, agentReview, reviewSkills, findPullRequest = findOpenPullRequest, }) {
    const settingsHttp = new SettingsHttp(settings, log);
    const reviewWatcher = new ReviewWatcher(service, log);
    const token = randomBytes(24).toString("base64url");
    const clients = new Set();
    const pullRequestCache = new Map();
    let port = 0;
    const broadcast = (event, data) => {
        const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const res of clients)
            res.write(frame);
    };
    const onChanged = (e) => {
        if (e.reason === "agent-review-settings" || e.reviewId === getReviewId())
            broadcast("changed", e);
    };
    const onSession = (e) => broadcast("session", e);
    service.on("changed", onChanged);
    delivery.on("session", onSession);
    const heartbeat = setInterval(() => {
        for (const res of clients)
            res.write(": ping\n\n");
    }, 20000);
    heartbeat.unref?.();
    // Dev hot reload: when the UI files change on disk, tell open pages to reload themselves.
    // Directory watchers also fire on reads (last-access), so only broadcast when mtime/size really changed.
    const assetSignature = async () => (await Promise.all(ASSET_FILES.map((file) => stat(path.join(webRoot, file)).then((s) => `${file}:${s.mtimeMs}:${s.size}`, () => `${file}:missing`)))).join("|");
    let signature = await assetSignature();
    let assetTimer;
    let watcher;
    try {
        watcher = watch(webRoot, { persistent: false }, () => {
            clearTimeout(assetTimer);
            assetTimer = setTimeout(async () => {
                const next = await assetSignature();
                if (next === signature)
                    return;
                signature = next;
                broadcast("assets", {});
            }, ASSET_DEBOUNCE_MS);
            assetTimer.unref?.();
        });
        watcher.on("error", (error) => log(`self-review: asset watcher stopped: ${error.message}`, "warning"));
    }
    catch (error) {
        log(`self-review: asset watcher unavailable: ${errorMessage(error)}`, "warning");
    }
    const deliverAsync = (reviewId, threadId, messageId) => {
        delivery.deliver(reviewId, threadId, messageId, instanceId).catch((err) => {
            log(`self-review: delivery error for ${messageId}: ${errorMessage(err)}`, "warning");
            service.setDelivery(reviewId, messageId, { state: "failed", error: errorMessage(err) }).catch(() => { });
        });
    };
    async function readPullRequest(review) {
        const branch = review.branch;
        if (!branch)
            return null;
        const key = `${review.repoRoot}\0${branch}`;
        const cached = pullRequestCache.get(key);
        if (cached && cached.expiresAt > Date.now())
            return "promise" in cached ? cached.promise : cached.value;
        const promise = Promise.resolve()
            .then(() => findPullRequest(review.repoRoot, branch))
            .catch((error) => {
            log(`self-review: could not discover an open pull request: ${errorMessage(error)}`, "warning");
            return null;
        })
            .then((value) => {
            pullRequestCache.set(key, { value, expiresAt: Date.now() + PULL_REQUEST_CACHE_MS });
            return value;
        });
        pullRequestCache.set(key, { promise, expiresAt: Infinity });
        return promise;
    }
    // An explicit draft flag wins; otherwise the repository's delivery mode decides, and an undecided ask-mode review holds.
    async function shouldHold(reviewId, draft) {
        if (draft !== undefined) {
            if (typeof draft !== "boolean")
                throw new HttpError(400, "invalid_input", "draft must be a boolean.");
            return draft;
        }
        if (!settings)
            return false;
        const review = await service.getReview(reviewId);
        return resolveDelivery((await settingsHttp.repo(review.repoRoot))?.delivery, review) !== "immediate";
    }
    async function api(req, res, url) {
        const provided = req.headers["x-mr-token"] ?? (req.method === "GET" ? url.searchParams.get("t") : null);
        if (!tokenMatches(token, provided))
            throw new HttpError(403, "forbidden", "Invalid token.");
        const origin = req.headers.origin;
        if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
            throw new HttpError(403, "forbidden", "Cross-origin request rejected.");
        }
        const reviewId = getReviewId();
        const parts = url.pathname.split("/").filter(Boolean).slice(1);
        if (req.method === "GET") {
            if (parts[0] === "state" && parts.length === 1) {
                const review = await service.getReview(reviewId);
                return send(res, 200, { instanceId, review, session: { busy: delivery.busy }, pullRequest: await readPullRequest(review), agentReviewAvailable: Boolean(agentReview), reviewSkillsAvailable: Boolean(reviewSkills), agentReviewSuggestedModels: SUGGESTED_REVIEWERS, ...await settingsHttp.read(review.repoRoot) });
            }
            if (parts[0] === "review-skills" && parts.length === 1) {
                if (!reviewSkills)
                    throw new HttpError(501, "unsupported", "Bundled review skills are not available.");
                return send(res, 200, await reviewSkills.read());
            }
            if (parts[0] === "snapshot" && parts.length === 2) {
                return send(res, 200, await service.getSnapshot(reviewId, parts[1]));
            }
            if (parts[0] === "content" && parts.length === 2) {
                return send(res, 200, await service.getFileContent(reviewId, parts[1], url.searchParams.get("path")));
            }
            if (parts[0] === "events" && parts.length === 1) {
                res.writeHead(200, {
                    "Content-Type": "text/event-stream; charset=utf-8",
                    "Cache-Control": "no-store",
                    Connection: "keep-alive",
                    "X-Accel-Buffering": "no",
                });
                res.write(`event: hello\ndata: ${JSON.stringify({ reviewId, busy: delivery.busy })}\n\n`);
                clients.add(res);
                req.on("close", () => clients.delete(res));
                return undefined;
            }
            throw new HttpError(404, "not_found", "Unknown endpoint.");
        }
        if (req.method !== "POST")
            throw new HttpError(405, "invalid_input", "Method not allowed.");
        if (!req.headers["x-mr-token"])
            throw new HttpError(403, "forbidden", "Token header required.");
        // The page names the review it is showing; after a scope switch an older page must not write into the new review.
        const pageReview = req.headers["x-mr-review"];
        if (pageReview !== undefined && pageReview !== reviewId) {
            throw new HttpError(409, "conflict", "This canvas now shows a different review. Your comment was not saved; reload and try again.");
        }
        const body = recordBody(await readJsonBody(req));
        if (parts[0] === "review-skills" && parts.length === 1) {
            if (!reviewSkills)
                throw new HttpError(501, "unsupported", "Bundled review skills are not available.");
            if (typeof body.saveDefaults !== "boolean")
                throw new HttpError(400, "invalid_input", "Choose whether to save skill defaults.");
            return send(res, 200, await reviewSkills.update(body.names, { saveDefaults: body.saveDefaults }));
        }
        if (parts[0] === "agent-review-settings" && parts.length === 1) {
            const saved = await settingsHttp.updateAgentReview(body);
            service.changed(reviewId, "agent-review-settings");
            return send(res, 200, saved);
        }
        if (parts[0] === "agent-reviews") {
            if (!agentReview)
                throw new HttpError(501, "unsupported", "Agent review is not available. Reload the extension.");
            if (pageReview !== reviewId)
                throw new HttpError(409, "conflict", "Refresh the canvas before starting or closing an agent review.");
            if (parts.length === 1) {
                if (body.oneClick === true && !(await settings?.getAgentReview?.())?.skipDialog) {
                    throw new HttpError(409, "conflict", "Saved defaults no longer allow one-click reviews. Confirm the current settings before starting.");
                }
                const { oneClick: _oneClick, ...input } = body;
                return send(res, 200, await agentReview.start(reviewId, input, instanceId));
            }
            if (parts.length === 3 && parts[2] === "close")
                return send(res, 200, await agentReview.close(reviewId, parts[1]));
        }
        if (parts[0] === "threads" && parts.length === 3 && parts[2] === "approve") {
            if (!agentReview)
                throw new HttpError(501, "unsupported", "Agent review is not available. Reload the extension.");
            if (pageReview !== reviewId)
                throw new HttpError(409, "conflict", "Refresh the canvas before approving a finding.");
            const revisionId = body.revisionId;
            if (revisionId !== undefined && typeof revisionId !== "string") {
                throw new HttpError(400, "invalid_input", "revisionId must be a string.");
            }
            const approved = await agentReview.approve(reviewId, parts[1], revisionId);
            const result = await delivery.deliver(reviewId, approved.threadId, approved.messageId, instanceId);
            return send(res, 200, { ...approved, ...result });
        }
        if (parts[0] === "threads" && parts.length === 1) {
            const hold = await shouldHold(reviewId, body.draft);
            const { thread, message, duplicate } = await service.createThread(reviewId, { ...body, author: "user", hold });
            if (!duplicate && !hold)
                deliverAsync(reviewId, thread.threadId, message.messageId);
            return send(res, 200, { threadId: thread.threadId, messageId: message.messageId, duplicate, draft: message.delivery?.state === "draft" });
        }
        if (parts[0] === "threads" && parts.length === 3 && parts[2] === "messages") {
            const hold = await shouldHold(reviewId, body.draft);
            const { thread, message, duplicate } = await service.addMessage(reviewId, parts[1], { body: body.body, clientRequestId: body.clientRequestId, descriptionVersion: body.descriptionVersion, author: "user", hold });
            if (!duplicate && !hold)
                deliverAsync(reviewId, thread.threadId, message.messageId);
            return send(res, 200, { threadId: thread.threadId, messageId: message.messageId, duplicate, draft: message.delivery?.state === "draft" });
        }
        if (parts[0] === "threads" && parts.length === 3 && parts[2] === "status") {
            const thread = await service.setThreadStatus(reviewId, parts[1], body.status);
            return send(res, 200, { threadId: thread.threadId, status: thread.status });
        }
        if (parts[0] === "messages" && parts.length === 3 && parts[2] === "retry") {
            const { thread, message } = await service.findMessage(reviewId, parts[1]);
            if (message.author !== "user")
                throw new HttpError(400, "invalid_input", "Only user messages can be resent.");
            const result = await delivery.deliver(reviewId, thread.threadId, message.messageId, instanceId, { retry: true });
            return send(res, 200, result);
        }
        if (parts[0] === "messages" && parts.length === 3 && parts[2] === "send") {
            const { thread, message } = await service.findMessage(reviewId, parts[1]);
            if (message.author !== "user" || message.delivery?.state !== "draft") {
                throw new HttpError(409, "conflict", "Only draft comments can be sent individually.");
            }
            return send(res, 200, await delivery.deliver(reviewId, thread.threadId, message.messageId, instanceId));
        }
        if (parts[0] === "messages" && parts.length === 3 && parts[2] === "discard") {
            return send(res, 200, await service.discardDraft(reviewId, parts[1]));
        }
        if (parts[0] === "submit" && parts.length === 1) {
            return send(res, 200, await delivery.submit(reviewId, instanceId));
        }
        if (parts[0] === "delivery" && parts.length === 1) {
            if (body.mode !== null && body.mode !== "immediate" && body.mode !== "batch") {
                throw new HttpError(400, "invalid_input", "mode must be immediate, batch, or null.");
            }
            const mode = await service.setDeliveryChoice(reviewId, body.mode);
            // Choosing immediate sends whatever was held while the review was undecided.
            const result = mode === "immediate" ? await delivery.submit(reviewId, instanceId) : { submitted: 0 };
            return send(res, 200, { mode, submitted: result.submitted, ...("error" in result && result.error ? { error: result.error } : {}) });
        }
        if (parts[0] === "refresh" && parts.length === 1) {
            return send(res, 200, await service.refresh(reviewId));
        }
        if (parts[0] === "settings" && parts.length === 1) {
            if (!settings)
                throw new HttpError(501, "unsupported", "Settings are not available.");
            const review = await service.getReview(reviewId);
            return send(res, 200, await settingsHttp.update(review.repoRoot, body));
        }
        if (parts[0] === "scope" && parts.length === 1) {
            if (!isReviewScope(body.scope))
                throw new HttpError(400, "invalid_input", `scope must be one of ${SCOPES.join(", ")}.`);
            if (!onReviewChange)
                throw new HttpError(501, "unsupported", "Switching scope is not available.");
            const nextId = await service.openSibling(reviewId, body.scope);
            if (nextId !== reviewId) {
                await onReviewChange(nextId);
                await reviewWatcher.setReview(nextId);
                service.changed(nextId, "scope");
            }
            return send(res, 200, { reviewId: nextId, scope: body.scope });
        }
        throw new HttpError(404, "not_found", "Unknown endpoint.");
    }
    const server = createServer(async (req, res) => {
        try {
            const host = req.headers.host ?? "";
            if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
                throw new HttpError(421, "forbidden", "Unexpected Host header.");
            }
            const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
            if (url.pathname.startsWith("/api/")) {
                await api(req, res, url);
                return;
            }
            const asset = STATIC[url.pathname];
            if (req.method !== "GET" || !asset)
                throw new HttpError(404, "not_found", "Not found.");
            send(res, 200, await readFile(path.join(webRoot, asset[0])), asset[1]);
        }
        catch (error) {
            const code = error instanceof HttpError
                ? error.code
                : isRecord(error) && typeof error.code === "string" ? error.code : "internal";
            const status = error instanceof HttpError ? error.status : STATUS_FOR_CODE[code] ?? 500;
            const message = errorMessage(error);
            if (status >= 500)
                log(`self-review: ${req.method} ${req.url?.split("?")[0]} failed: ${message}`, "warning");
            if (!res.headersSent)
                send(res, status, { error: { code, message } });
            else
                res.end();
        }
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("Review server did not bind to a TCP address.");
    port = address.port;
    await reviewWatcher.setReview(getReviewId());
    return {
        url: `http://127.0.0.1:${port}/?t=${token}`,
        notify: broadcast,
        watchReview: (reviewId) => reviewWatcher.setReview(reviewId),
        async close() {
            await reviewWatcher.close();
            clearInterval(heartbeat);
            clearTimeout(assetTimer);
            watcher?.close();
            service.off("changed", onChanged);
            delivery.off("session", onSession);
            for (const res of clients)
                res.end();
            clients.clear();
            const closed = new Promise((resolve) => server.close(() => resolve()));
            server.closeAllConnections?.();
            await closed;
        },
    };
}
