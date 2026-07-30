import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { CopilotCatalogCache, type CopilotCatalogRefreshResult } from "./copilot-catalog-cache.ts";
import type { CopilotCatalogSnapshot } from "./copilot-catalog.ts";

const CACHE_PATH = path.join(getAgentDir(), "cache", "model-chooser", "copilot-v1.json");
const cache = new CopilotCatalogCache({ cachePath: CACHE_PATH });

export function hydrateCopilotCatalog(): Promise<CopilotCatalogSnapshot | undefined> {
	return cache.hydrate();
}

export function getCopilotCatalogSnapshot(): CopilotCatalogSnapshot | undefined {
	return cache.getSnapshot();
}

export function refreshCopilotCatalog(
	loader: (signal: AbortSignal) => Promise<readonly unknown[]>,
	options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<CopilotCatalogRefreshResult> {
	return cache.refresh(loader, options);
}

export function getCopilotCatalogStatus(models: readonly { provider: string; id: string }[] = []) {
	const snapshot = cache.getSnapshot();
	const known = new Set(snapshot?.models.map((model) => model.id.toLowerCase()) ?? []);
	const copilotModels = models.filter((model) => model.provider.toLowerCase() === "github-copilot");
	const unmatchedModels = copilotModels
		.filter((model) => !known.has(model.id.toLowerCase()))
		.map((model) => `${model.provider}/${model.id}`);
	return {
		cachePath: CACHE_PATH,
		available: snapshot !== undefined,
		fresh: cache.isFresh(snapshot),
		fetchedAt: snapshot?.fetchedAt,
		freshUntil: snapshot?.freshUntil,
		models: snapshot?.models.length ?? 0,
		matchedModels: copilotModels.length - unmatchedModels.length,
		unmatchedModels,
	};
}
