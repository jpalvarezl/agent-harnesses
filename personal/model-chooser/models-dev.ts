import type { MetadataAttribution, SignalProvenance } from "./index.ts";

export const MODELS_DEV_CATALOG_URL = "https://models.dev/catalog.json";
export const MODELS_DEV_CACHE_VERSION = 1 as const;

export interface ModelsDevCost {
	input: number;
	output: number;
}

export interface ModelsDevRoute {
	provider: string;
	id: string;
	name?: string;
	family?: string;
	description?: string;
	releaseDate?: string;
	cost?: ModelsDevCost;
}

export interface ModelsDevCanonicalModel {
	id: string;
	vendor: string;
	modelId: string;
	name?: string;
	family?: string;
}

export interface ModelsDevSnapshot {
	version: typeof MODELS_DEV_CACHE_VERSION;
	sourceUrl: typeof MODELS_DEV_CATALOG_URL;
	fetchedAt: string;
	validatedAt: string;
	freshUntil: string;
	etag?: string;
	routes: ModelsDevRoute[];
	models: ModelsDevCanonicalModel[];
}

export interface ModelsDevEnrichment {
	family?: string;
	vendor?: string;
	description?: string;
	releaseDate?: string;
	cost?: ModelsDevCost;
	identityMetadata?: {
		family?: MetadataAttribution;
		vendor?: MetadataAttribution;
	};
	costProvenance?: SignalProvenance;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nonNegativeFinite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseCost(value: unknown): ModelsDevCost | undefined {
	if (!isRecord(value)) return undefined;
	const input = nonNegativeFinite(value.input);
	const output = nonNegativeFinite(value.output);
	if (input === undefined || output === undefined || input + output <= 0) return undefined;
	return { input, output };
}

function normalize(value: string): string {
	return value.trim().toLowerCase();
}

/** Punctuation-insensitive identity key used only after exact route matching. */
function identityKey(value: string): string {
	return normalize(value).replace(/[^a-z0-9]+/g, "");
}

function parseCanonicalModels(value: unknown): ModelsDevCanonicalModel[] {
	if (!isRecord(value)) return [];
	const models: ModelsDevCanonicalModel[] = [];
	for (const [key, raw] of Object.entries(value)) {
		if (!isRecord(raw)) continue;
		const id = optionalString(raw.id) ?? key;
		const slash = id.indexOf("/");
		if (slash <= 0 || slash === id.length - 1) continue;
		models.push({
			id,
			vendor: id.slice(0, slash),
			modelId: id.slice(slash + 1),
			name: optionalString(raw.name),
			family: optionalString(raw.family),
		});
	}
	return models;
}

function parseRoutes(value: unknown): ModelsDevRoute[] {
	if (!isRecord(value)) return [];
	const routes: ModelsDevRoute[] = [];
	for (const [providerKey, rawProvider] of Object.entries(value)) {
		if (!isRecord(rawProvider) || !isRecord(rawProvider.models)) continue;
		const provider = optionalString(rawProvider.id) ?? providerKey;
		for (const [modelKey, rawModel] of Object.entries(rawProvider.models)) {
			if (!isRecord(rawModel)) continue;
			const id = optionalString(rawModel.id) ?? modelKey;
			if (!id) continue;
			routes.push({
				provider,
				id,
				name: optionalString(rawModel.name),
				family: optionalString(rawModel.family),
				description: optionalString(rawModel.description),
				releaseDate: optionalString(rawModel.release_date),
				cost: parseCost(rawModel.cost),
			});
		}
	}
	return routes;
}

export function projectModelsDevCatalog(
	value: unknown,
	metadata: {
		fetchedAt: string;
		validatedAt?: string;
		freshUntil: string;
		etag?: string;
	},
): ModelsDevSnapshot {
	if (!isRecord(value)) throw new Error("models.dev catalog root must be an object");
	const models = parseCanonicalModels(value.models);
	const routes = parseRoutes(value.providers);
	if (models.length === 0 || routes.length === 0) throw new Error("models.dev catalog has no usable models or routes");
	return {
		version: MODELS_DEV_CACHE_VERSION,
		sourceUrl: MODELS_DEV_CATALOG_URL,
		fetchedAt: metadata.fetchedAt,
		validatedAt: metadata.validatedAt ?? metadata.fetchedAt,
		freshUntil: metadata.freshUntil,
		etag: metadata.etag,
		routes,
		models,
	};
}

export function isModelsDevSnapshot(value: unknown): value is ModelsDevSnapshot {
	if (!isRecord(value)) return false;
	if (value.version !== MODELS_DEV_CACHE_VERSION || value.sourceUrl !== MODELS_DEV_CATALOG_URL) return false;
	if (
		![value.fetchedAt, value.validatedAt, value.freshUntil].every(
			(entry) => typeof entry === "string" && Number.isFinite(Date.parse(entry)),
		)
	)
		return false;
	if (value.etag !== undefined && typeof value.etag !== "string") return false;
	if (!Array.isArray(value.routes) || !Array.isArray(value.models)) return false;
	const optionalFieldsAreStrings = (entry: Record<string, unknown>, fields: string[]) =>
		fields.every((field) => entry[field] === undefined || typeof entry[field] === "string");
	return value.routes.every(
		(route) => {
			if (!isRecord(route) || typeof route.provider !== "string" || typeof route.id !== "string") return false;
			if (!optionalFieldsAreStrings(route, ["name", "family", "description", "releaseDate"])) return false;
			if (route.cost === undefined) return true;
			if (!isRecord(route.cost)) return false;
			const input = route.cost.input;
			const output = route.cost.output;
			return (
				typeof input === "number" &&
				Number.isFinite(input) &&
				input >= 0 &&
				typeof output === "number" &&
				Number.isFinite(output) &&
				output >= 0 &&
				input + output > 0
			);
		},
	) && value.models.every(
		(model) =>
			isRecord(model) &&
			typeof model.id === "string" &&
			typeof model.vendor === "string" &&
			typeof model.modelId === "string" &&
			optionalFieldsAreStrings(model, ["name", "family"]),
	);
}

function sourceProvenance(snapshot: ModelsDevSnapshot, now: Date, detail: string): SignalProvenance {
	return {
		source: "models.dev",
		url: snapshot.sourceUrl,
		fetchedAt: snapshot.fetchedAt,
		freshness: now.getTime() <= Date.parse(snapshot.freshUntil) ? "fresh" : "stale",
		detail,
	};
}

function uniqueCanonicalMatch(
	snapshot: ModelsDevSnapshot,
	input: { id: string; name?: string; family?: string },
): { model?: ModelsDevCanonicalModel; confidence?: number; method?: string } {
	const family = input.family ? normalize(input.family) : undefined;
	const byId = snapshot.models.filter(
		(model) => identityKey(model.modelId) === identityKey(input.id) && (!family || normalize(model.family ?? "") === family),
	);
	if (byId.length === 1) return { model: byId[0], confidence: 0.95, method: "punctuation-normalized canonical id" };
	if (!input.name) return {};
	const byName = snapshot.models.filter(
		(model) =>
			model.name &&
			identityKey(model.name) === identityKey(input.name!) &&
			(!family || normalize(model.family ?? "") === family),
	);
	return byName.length === 1
		? { model: byName[0], confidence: 0.85, method: "unique canonical name and family" }
		: {};
}

/**
 * Enrich only an existing Pi model. Route cost/family require an exact
 * provider/id match; vendor requires a unique canonical models.dev match.
 */
export function lookupModelsDevMetadata(
	snapshot: ModelsDevSnapshot | undefined,
	input: { provider: string; id: string; name?: string },
	now = new Date(),
): ModelsDevEnrichment | undefined {
	if (!snapshot) return undefined;
	const route = snapshot.routes.find(
		(candidate) => normalize(candidate.provider) === normalize(input.provider) && normalize(candidate.id) === normalize(input.id),
	);
	const canonical = uniqueCanonicalMatch(snapshot, {
		id: input.id,
		name: input.name ?? route?.name,
		family: route?.family,
	});
	if (!route && !canonical.model) return undefined;

	const enrichment: ModelsDevEnrichment = {
		family: route?.family ?? canonical.model?.family,
		vendor: canonical.model?.vendor,
		description: route?.description,
		releaseDate: route?.releaseDate,
		cost: route?.cost,
	};
	if (enrichment.family) {
		enrichment.identityMetadata ??= {};
		enrichment.identityMetadata.family = {
			confidence: route ? 0.95 : 0.8,
			provenance: sourceProvenance(snapshot, now, route ? "exact provider/model route family" : "canonical model family"),
		};
	}
	if (enrichment.vendor && canonical.confidence) {
		enrichment.identityMetadata ??= {};
		enrichment.identityMetadata.vendor = {
			confidence: canonical.confidence,
			provenance: sourceProvenance(snapshot, now, canonical.method ?? "canonical model vendor"),
		};
	}
	if (enrichment.cost) {
		enrichment.costProvenance = sourceProvenance(
			snapshot,
			now,
			"Exact-route USD-per-million-token list-price proxy; not subscription credits or Copilot premium requests",
		);
	}
	return enrichment;
}
