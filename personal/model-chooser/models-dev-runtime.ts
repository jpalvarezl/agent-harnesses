import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { ModelsDevCache, type ModelsDevRefreshResult } from "./models-dev-cache.ts";
import { lookupModelsDevMetadata, type ModelsDevSnapshot } from "./models-dev.ts";

const CACHE_PATH = path.join(getAgentDir(), "cache", "model-chooser", "models-dev-v1.json");
const cache = new ModelsDevCache({ cachePath: CACHE_PATH });

export function hydrateModelsDevMetadata(): Promise<ModelsDevSnapshot | undefined> {
	return cache.hydrate();
}

export function getModelsDevMetadataSnapshot(): ModelsDevSnapshot | undefined {
	return cache.getSnapshot();
}

export function refreshModelsDevMetadata(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<ModelsDevRefreshResult> {
	return cache.refresh(options);
}

export function getModelsDevMetadataStatus(
	models: readonly { provider: string; id: string; name?: string }[] = [],
): {
	cachePath: string;
	available: boolean;
	fresh: boolean;
	fetchedAt?: string;
	validatedAt?: string;
	freshUntil?: string;
	etag?: string;
	routes: number;
	canonicalModels: number;
	matchedModels: number;
	unmatchedModels: string[];
} {
	const snapshot = cache.getSnapshot();
	const unmatchedModels = snapshot
		? models.filter((model) => !lookupModelsDevMetadata(snapshot, model)).map((model) => `${model.provider}/${model.id}`)
		: models.map((model) => `${model.provider}/${model.id}`);
	return {
		cachePath: CACHE_PATH,
		available: snapshot !== undefined,
		fresh: cache.isFresh(snapshot),
		fetchedAt: snapshot?.fetchedAt,
		validatedAt: snapshot?.validatedAt,
		freshUntil: snapshot?.freshUntil,
		etag: snapshot?.etag,
		routes: snapshot?.routes.length ?? 0,
		canonicalModels: snapshot?.models.length ?? 0,
		matchedModels: models.length - unmatchedModels.length,
		unmatchedModels,
	};
}
