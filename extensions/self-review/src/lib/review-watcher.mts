import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { runGit } from "./git-process.mjs";
import type { Log } from "../../types/contracts.js";
import type { ReviewService } from "./review-service.mjs";

const DEBOUNCE_MS = 350;
const MAX_DEBOUNCE_MS = 1500;
const gitInput = (name: string) => !name.endsWith(".lock")
    && (/^(HEAD|index|packed-refs|config|shallow|info\/exclude)$/.test(name) || name.startsWith("refs/")
        || (name.startsWith("modules/") && (/\/(HEAD|index|packed-refs|config|shallow|info\/exclude)$/.test(name) || name.includes("/refs/"))));
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
type WatchDirectory = (root: string, changed: (file: string | null) => void, failed: (error: Error) => void) => Pick<FSWatcher, "close">;
type FileInventory = { files: Set<string>; directories: Set<string> };
type GitInventory = FileInventory & { submodules: Set<string>; submoduleFiles: Map<string, FileInventory> };
function fileInventory(files: Iterable<string>): FileInventory {
    const inventory: FileInventory = { files: new Set(files), directories: new Set() };
    for (const file of inventory.files) {
        let parent = path.posix.dirname(file);
        while (parent !== ".") {
            inventory.directories.add(parent);
            parent = path.posix.dirname(parent);
        }
    }
    return inventory;
}
function matchesPaths(inventories: FileInventory[], paths: string[]): boolean {
    return paths.some((file) => inventories.some((inventory) => inventory.files.has(file) || inventory.directories.has(file)));
}
const createDirectoryWatcher: WatchDirectory = (root, changed, failed) => {
    const watcher = watch(root, { recursive: true, persistent: false }, (_event, file) => changed(file?.toString() ?? null));
    watcher.on("error", failed);
    return watcher;
};

// Each open panel owns one watcher; switching reviews or closing the panel releases it.
export class ReviewWatcher {
    private watchers: Array<Pick<FSWatcher, "close">> = [];
    private timer: ReturnType<typeof setTimeout> | undefined;
    private maxTimer: ReturnType<typeof setTimeout> | undefined;
    private generation = 0;
    private reviewId: string | null = null;
    private candidates = new Map<string, { file: string; git: boolean }>();
    private closed = false;
    private running: Promise<void> = Promise.resolve();

    constructor(
        private readonly service: Pick<ReviewService, "getReview" | "refresh">,
        private readonly log: Log,
        private readonly debounceMs = DEBOUNCE_MS,
        private readonly watchDirectory: WatchDirectory = createDirectoryWatcher,
    ) {}

    async setReview(reviewId: string): Promise<void> {
        if (this.closed || this.reviewId === reviewId) return;
        this.release();
        this.reviewId = reviewId;
        const generation = this.generation;
        const signatures = new Map<string, string>();
        try {
            const review = await this.service.getReview(reviewId);
            const submoduleInventory = async (submodule: string) => {
                const result = await runGit(path.join(review.repoRoot, submodule), ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
                return fileInventory(result.stdout.split("\0").filter(Boolean));
            };
            const inventory = async (): Promise<GitInventory> => {
                const result = await runGit(review.repoRoot, ["ls-files", "--stage", "--cached", "--others", "--exclude-standard", "-z"]);
                const submodules = new Set<string>();
                const files: string[] = [];
                for (const entry of result.stdout.split("\0").filter(Boolean)) {
                    const staged = /^(\d{6}) [0-9a-f]+ [0-3]\t([\s\S]*)$/.exec(entry);
                    const file = staged ? staged[2] : entry;
                    files.push(file);
                    if (staged?.[1] === "160000") submodules.add(file);
                }
                return { ...fileInventory(files), submodules, submoduleFiles: new Map() };
            };
            const [dirs, initialFiles] = await Promise.all([
                runGit(review.repoRoot, ["rev-parse", "--absolute-git-dir", "--path-format=absolute", "--git-common-dir"]),
                inventory(),
            ]);
            for (const [submodule, files] of await Promise.all([...initialFiles.submodules].map(async (submodule) =>
                [submodule, await submoduleInventory(submodule)] as const))) {
                initialFiles.submoduleFiles.set(submodule, files);
            }
            let known = initialFiles;
            if (generation !== this.generation || this.closed) return;
            const add = (root: string, metadata: boolean) => {
                const flush = () => {
                    clearTimeout(this.timer);
                    clearTimeout(this.maxTimer);
                    this.timer = undefined;
                    this.maxTimer = undefined;
                    const candidates = this.candidates;
                    this.candidates = new Map();
                    // Serialize checks as well as refreshes: read notifications must not race signature updates.
                    this.running = this.running.then(async () => {
                        if (generation !== this.generation || this.closed) return;
                        let relevant = false;
                        let rescan = false;
                        const changedPaths: string[] = [];
                        for (const [absolute, candidate] of candidates) {
                            if (!candidate.file) {
                                relevant = true;
                                rescan = true;
                                continue;
                            }
                            const submoduleRoot = !candidate.git && known.submodules.has(candidate.file);
                            const file = await lstat(absolute).then(
                                (s) => ({
                                    directory: s.isDirectory(),
                                    signature: candidate.git && s.isDirectory() ? null : `${s.mtimeMs}:${s.ctimeMs}:${s.size}:${s.mode}:${s.ino}`,
                                }),
                                (error: NodeJS.ErrnoException) => {
                                    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { directory: false, signature: "missing" };
                                    throw error;
                                },
                            );
                            const { signature } = file;
                            if (signature === null || signatures.get(absolute) === signature) continue;
                            signatures.set(absolute, signature);
                            // Recursive watchers can report child creation at the submodule directory itself.
                            // Its tracked/ignored content is checked through the nested Git inventory instead.
                            if (submoduleRoot && file.directory) continue;
                            if (candidate.git) {
                                relevant = true;
                                continue;
                            }
                            changedPaths.push(candidate.file);
                        }
                        if (changedPaths.length || rescan) {
                            // Keep the old inventory too, so deleting an untracked reviewed file still refreshes.
                            const nextRoot = await inventory();
                            const next: GitInventory = { ...nextRoot, submoduleFiles: new Map(known.submoduleFiles) };
                            for (const submodule of next.submodules) {
                                if (!next.submoduleFiles.has(submodule)) {
                                    next.submoduleFiles.set(submodule, await submoduleInventory(submodule));
                                }
                            }
                            if (matchesPaths([known, next], changedPaths)) relevant = true;

                            const submodulePaths = new Map<string, string[]>();
                            for (const changed of changedPaths) {
                                let parent = path.posix.dirname(changed);
                                while (parent !== ".") {
                                    if (known.submodules.has(parent) || next.submodules.has(parent)) {
                                        const entries = submodulePaths.get(parent) ?? [];
                                        entries.push(path.posix.relative(parent, changed));
                                        submodulePaths.set(parent, entries);
                                        break;
                                    }
                                    parent = path.posix.dirname(parent);
                                }
                            }
                            for (const [submodule, paths] of submodulePaths) {
                                const previous = known.submoduleFiles.get(submodule) ?? fileInventory([]);
                                const current = next.submodules.has(submodule)
                                    ? await submoduleInventory(submodule)
                                    : undefined;
                                if (current) next.submoduleFiles.set(submodule, current);
                                if (previous && current && matchesPaths([previous, current], paths)) relevant = true;
                                if (!next.submodules.has(submodule)) next.submoduleFiles.delete(submodule);
                            }
                            known = next;
                        }
                        if (relevant && generation === this.generation && !this.closed) await this.service.refresh(reviewId);
                    }).catch((error: unknown) => this.warn(error));
                };
                const watcher = this.watchDirectory(root, (filename) => {
                    if (generation !== this.generation || this.closed) return;
                    const file = filename?.replace(/\\/g, "/") ?? "";
                    if (metadata ? file && !gitInput(file) : file.split("/").includes(".git")) return;
                    const absolute = path.join(root, file);
                    this.candidates.set(absolute, { file, git: metadata });
                    clearTimeout(this.timer);
                    this.timer = setTimeout(flush, this.debounceMs);
                    if (this.maxTimer === undefined) this.maxTimer = setTimeout(flush, Math.max(MAX_DEBOUNCE_MS, this.debounceMs));
                    this.timer.unref();
                    this.maxTimer.unref();
                }, (error) => {
                    this.warn(error);
                    watcher.close();
                });
                this.watchers.push(watcher);
            };
            add(review.repoRoot, false);
            for (const dir of new Set(dirs.stdout.trim().split(/\r?\n/))) add(dir, true);
            // Close the capture-to-watch gap, using the existing coalesced refresh.
            await this.service.refresh(reviewId);
        } catch (error) {
            if (generation === this.generation) {
                this.release();
                this.warn(error);
            }
        }
    }

    private warn(error: unknown): void {
        this.log(`self-review: automatic refresh unavailable: ${message(error)}. Manual Refresh remains available.`, "warning");
    }

    private release(): void {
        this.generation++;
        clearTimeout(this.timer);
        clearTimeout(this.maxTimer);
        this.timer = undefined;
        this.maxTimer = undefined;
        for (const watcher of this.watchers) watcher.close();
        this.watchers = [];
        this.candidates.clear();
        this.reviewId = null;
    }

    async close(): Promise<void> {
        this.closed = true;
        this.release();
        await this.running;
    }
}
