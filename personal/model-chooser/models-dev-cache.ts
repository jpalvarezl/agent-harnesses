import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
	MODELS_DEV_CATALOG_URL,
	isModelsDevSnapshot,
	projectModelsDevCatalog,
	type ModelsDevSnapshot,
} from "./models-dev.ts";

export const DEFAULT_MODELS_DEV_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MODELS_DEV_TIMEOUT_MS = 20_000;

export type ModelsDevRefreshStatus = "fresh" | "updated" | "not-modified" | "offline" | "error";

export interface ModelsDevRefreshResult {
	status: ModelsDevRefreshStatus;
	snapshot?: ModelsDevSnapshot;
	error?: string;
}

export interface ModelsDevCacheOptions {
	cachePath: string;
	fetchImpl?: typeof fetch;
	now?: () => Date;
	ttlMs?: number;
	timeoutMs?: number;
	offline?: () => boolean;
}

export function isOfflineValue(value: string | undefined): boolean {
	return /^(1|true|yes)$/i.test(value?.trim() ?? "");
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class ModelsDevCache {
	private readonly cachePath: string;
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => Date;
	private readonly ttlMs: number;
	private readonly timeoutMs: number;
	private readonly offline: () => boolean;
	private snapshot?: ModelsDevSnapshot;
	private hydrated = false;
	private hydrateInFlight?: Promise<ModelsDevSnapshot | undefined>;
	private inFlight?: Promise<ModelsDevRefreshResult>;

	constructor(options: ModelsDevCacheOptions) {
		this.cachePath = options.cachePath;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.now = options.now ?? (() => new Date());
		this.ttlMs = options.ttlMs ?? DEFAULT_MODELS_DEV_TTL_MS;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_MODELS_DEV_TIMEOUT_MS;
		this.offline = options.offline ?? (() => isOfflineValue(process.env.PI_OFFLINE));
	}

	hydrate(): Promise<ModelsDevSnapshot | undefined> {
		if (this.hydrated) return Promise.resolve(this.snapshot);
		this.hydrateInFlight ??= (async () => {
			try {
				const parsed: unknown = JSON.parse(await fs.readFile(this.cachePath, "utf8"));
				if (isModelsDevSnapshot(parsed)) this.snapshot = parsed;
			} catch {
				// Missing/corrupt cache is equivalent to no enrichment. Selection remains
				// available from Pi metadata and never treats this as a fatal condition.
			} finally {
				this.hydrated = true;
			}
			return this.snapshot;
		})().finally(() => {
			this.hydrateInFlight = undefined;
		});
		return this.hydrateInFlight;
	}

	getSnapshot(): ModelsDevSnapshot | undefined {
		return this.snapshot;
	}

	isFresh(snapshot = this.snapshot): boolean {
		return Boolean(snapshot && this.now().getTime() <= Date.parse(snapshot.freshUntil));
	}

	refresh(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<ModelsDevRefreshResult> {
		if (this.inFlight) {
			// A user-forced refresh queued behind background revalidation must still
			// perform its own conditional request after the shared request settles.
			return options.force ? this.inFlight.then(() => this.refresh(options)) : this.inFlight;
		}
		this.inFlight = this.refreshOnce(options).finally(() => {
			this.inFlight = undefined;
		});
		return this.inFlight;
	}

	private async refreshOnce(options: { force?: boolean; signal?: AbortSignal }): Promise<ModelsDevRefreshResult> {
		await this.hydrate();
		if (this.offline()) return { status: "offline", snapshot: this.snapshot };
		if (!options.force && this.isFresh()) return { status: "fresh", snapshot: this.snapshot };

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
		const abort = () => controller.abort();
		options.signal?.addEventListener("abort", abort, { once: true });
		try {
			const response = await this.fetchImpl(MODELS_DEV_CATALOG_URL, {
				headers: {
					accept: "application/json",
					...(this.snapshot?.etag ? { "if-none-match": this.snapshot.etag } : {}),
				},
				signal: controller.signal,
			});
			const now = this.now();
			const validatedAt = now.toISOString();
			const freshUntil = new Date(now.getTime() + this.ttlMs).toISOString();
			if (response.status === 304 && this.snapshot) {
				const refreshed: ModelsDevSnapshot = { ...this.snapshot, validatedAt, freshUntil };
				await this.writeAtomic(refreshed);
				this.snapshot = refreshed;
				return { status: "not-modified", snapshot: refreshed };
			}
			if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
			const projected = projectModelsDevCatalog(await response.json(), {
				fetchedAt: validatedAt,
				validatedAt,
				freshUntil,
				etag: response.headers.get("etag") ?? undefined,
			});
			await this.writeAtomic(projected);
			this.snapshot = projected;
			return { status: "updated", snapshot: projected };
		} catch (error) {
			return {
				status: "error",
				snapshot: this.snapshot,
				error: controller.signal.aborted ? "models.dev refresh aborted or timed out" : formatError(error),
			};
		} finally {
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", abort);
		}
	}

	private async writeAtomic(snapshot: ModelsDevSnapshot): Promise<void> {
		await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
		const temporaryPath = `${this.cachePath}.${process.pid}.${Date.now()}.tmp`;
		try {
			await fs.writeFile(temporaryPath, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", mode: 0o600 });
			await fs.rename(temporaryPath, this.cachePath);
			await fs.chmod(this.cachePath, 0o600).catch(() => undefined);
		} finally {
			await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
		}
	}
}
