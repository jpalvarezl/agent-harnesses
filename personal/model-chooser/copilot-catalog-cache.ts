import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
	isCopilotCatalogSnapshot,
	projectCopilotCatalog,
	type CopilotCatalogSnapshot,
} from "./copilot-catalog.ts";
import { isOfflineValue } from "./models-dev-cache.ts";

export const DEFAULT_COPILOT_CATALOG_TTL_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_COPILOT_CATALOG_TIMEOUT_MS = 20_000;

export interface CopilotCatalogRefreshResult {
	status: "fresh" | "updated" | "offline" | "error";
	snapshot?: CopilotCatalogSnapshot;
	error?: string;
}

export interface CopilotCatalogCacheOptions {
	cachePath: string;
	now?: () => Date;
	ttlMs?: number;
	timeoutMs?: number;
	offline?: () => boolean;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class CopilotCatalogCache {
	private readonly cachePath: string;
	private readonly now: () => Date;
	private readonly ttlMs: number;
	private readonly timeoutMs: number;
	private readonly offline: () => boolean;
	private snapshot?: CopilotCatalogSnapshot;
	private hydrated = false;
	private hydrateInFlight?: Promise<CopilotCatalogSnapshot | undefined>;
	private refreshInFlight?: Promise<CopilotCatalogRefreshResult>;

	constructor(options: CopilotCatalogCacheOptions) {
		this.cachePath = options.cachePath;
		this.now = options.now ?? (() => new Date());
		this.ttlMs = options.ttlMs ?? DEFAULT_COPILOT_CATALOG_TTL_MS;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_COPILOT_CATALOG_TIMEOUT_MS;
		this.offline = options.offline ?? (() => isOfflineValue(process.env.PI_OFFLINE));
	}

	hydrate(): Promise<CopilotCatalogSnapshot | undefined> {
		if (this.hydrated) return Promise.resolve(this.snapshot);
		this.hydrateInFlight ??= (async () => {
			try {
				const parsed: unknown = JSON.parse(await fs.readFile(this.cachePath, "utf8"));
				if (isCopilotCatalogSnapshot(parsed)) this.snapshot = parsed;
			} catch {
				// Missing/corrupt cache leaves provider identity unknown, never fatal.
			} finally {
				this.hydrated = true;
			}
			return this.snapshot;
		})().finally(() => {
			this.hydrateInFlight = undefined;
		});
		return this.hydrateInFlight;
	}

	getSnapshot(): CopilotCatalogSnapshot | undefined {
		return this.snapshot;
	}

	isFresh(snapshot = this.snapshot): boolean {
		return Boolean(snapshot && this.now().getTime() <= Date.parse(snapshot.freshUntil));
	}

	refresh(
		loader: (signal: AbortSignal) => Promise<readonly unknown[]>,
		options: { force?: boolean; signal?: AbortSignal } = {},
	): Promise<CopilotCatalogRefreshResult> {
		if (this.refreshInFlight) {
			// A user-forced refresh queued behind startup revalidation must run its
			// own authenticated loader after the shared request settles.
			return options.force
				? this.refreshInFlight.then(() => this.refresh(loader, options))
				: this.refreshInFlight;
		}
		this.refreshInFlight = this.refreshOnce(loader, options).finally(() => {
			this.refreshInFlight = undefined;
		});
		return this.refreshInFlight;
	}

	private async refreshOnce(
		loader: (signal: AbortSignal) => Promise<readonly unknown[]>,
		options: { force?: boolean; signal?: AbortSignal },
	): Promise<CopilotCatalogRefreshResult> {
		await this.hydrate();
		if (options.signal?.aborted)
			return { status: "error", snapshot: this.snapshot, error: "Copilot catalog refresh aborted before start" };
		if (this.offline()) return { status: "offline", snapshot: this.snapshot };
		if (!options.force && this.isFresh()) return { status: "fresh", snapshot: this.snapshot };

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
		const abort = () => controller.abort();
		if (options.signal?.aborted) controller.abort();
		else options.signal?.addEventListener("abort", abort, { once: true });
		try {
			const entries = await loader(controller.signal);
			const now = this.now();
			const projected = projectCopilotCatalog(entries, {
				fetchedAt: now.toISOString(),
				freshUntil: new Date(now.getTime() + this.ttlMs).toISOString(),
			});
			await this.writeAtomic(projected);
			this.snapshot = projected;
			return { status: "updated", snapshot: projected };
		} catch (error) {
			return {
				status: "error",
				snapshot: this.snapshot,
				error: controller.signal.aborted ? "Copilot catalog refresh aborted or timed out" : formatError(error),
			};
		} finally {
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", abort);
		}
	}

	private async writeAtomic(snapshot: CopilotCatalogSnapshot): Promise<void> {
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
