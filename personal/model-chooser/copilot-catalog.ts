import type { MetadataAttribution, SignalProvenance } from "./index.ts";

export const COPILOT_CATALOG_VERSION = 1 as const;
export const COPILOT_PROVIDER = "github-copilot" as const;

export interface CopilotCatalogModel {
	id: string;
	name?: string;
	vendor?: string;
	modelFamily?: string;
}

export interface CopilotCatalogSnapshot {
	version: typeof COPILOT_CATALOG_VERSION;
	provider: typeof COPILOT_PROVIDER;
	fetchedAt: string;
	freshUntil: string;
	models: CopilotCatalogModel[];
}

export interface CopilotIdentityEnrichment {
	vendor?: string;
	modelFamily?: string;
	identityMetadata?: {
		vendor?: MetadataAttribution;
		modelFamily?: MetadataAttribution;
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalize(value: string): string {
	return value.trim().toLowerCase();
}

export function projectCopilotCatalog(
	entries: readonly unknown[],
	metadata: { fetchedAt: string; freshUntil: string },
): CopilotCatalogSnapshot {
	const models = new Map<string, CopilotCatalogModel>();
	for (const raw of entries) {
		if (!isRecord(raw)) continue;
		const id = optionalString(raw.id);
		if (!id) continue;
		const capabilities = isRecord(raw.capabilities) ? raw.capabilities : undefined;
		models.set(normalize(id), {
			id,
			name: optionalString(raw.name),
			vendor: optionalString(raw.vendor),
			modelFamily: optionalString(capabilities?.family),
		});
	}
	if (models.size === 0) throw new Error("Copilot catalog has no usable models");
	return {
		version: COPILOT_CATALOG_VERSION,
		provider: COPILOT_PROVIDER,
		fetchedAt: metadata.fetchedAt,
		freshUntil: metadata.freshUntil,
		models: [...models.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
	};
}

export function isCopilotCatalogSnapshot(value: unknown): value is CopilotCatalogSnapshot {
	if (!isRecord(value) || value.version !== COPILOT_CATALOG_VERSION || value.provider !== COPILOT_PROVIDER) return false;
	if (
		typeof value.fetchedAt !== "string" ||
		!Number.isFinite(Date.parse(value.fetchedAt)) ||
		typeof value.freshUntil !== "string" ||
		!Number.isFinite(Date.parse(value.freshUntil)) ||
		!Array.isArray(value.models)
	)
		return false;
	return value.models.every(
		(model) =>
			isRecord(model) &&
			typeof model.id === "string" &&
			[model.name, model.vendor, model.modelFamily].every((entry) => entry === undefined || typeof entry === "string"),
	);
}

function provenance(snapshot: CopilotCatalogSnapshot, now: Date, detail: string): SignalProvenance {
	return {
		source: "github-copilot-live-catalog",
		fetchedAt: snapshot.fetchedAt,
		freshness: now.getTime() <= Date.parse(snapshot.freshUntil) ? "fresh" : "stale",
		detail,
	};
}

/** Exact provider/id identity enrichment from the authenticated account catalog. */
export function lookupCopilotIdentity(
	snapshot: CopilotCatalogSnapshot | undefined,
	input: { provider: string; id: string },
	now = new Date(),
): CopilotIdentityEnrichment | undefined {
	if (!snapshot || normalize(input.provider) !== COPILOT_PROVIDER) return undefined;
	const model = snapshot.models.find((candidate) => normalize(candidate.id) === normalize(input.id));
	if (!model) return undefined;
	const enrichment: CopilotIdentityEnrichment = {
		vendor: model.vendor,
		modelFamily: model.modelFamily,
	};
	if (model.vendor) {
		enrichment.identityMetadata ??= {};
		enrichment.identityMetadata.vendor = {
			confidence: 0.99,
			provenance: provenance(snapshot, now, "exact authenticated Copilot provider/model vendor"),
		};
	}
	if (model.modelFamily) {
		enrichment.identityMetadata ??= {};
		enrichment.identityMetadata.modelFamily = {
			confidence: 0.98,
			provenance: provenance(snapshot, now, "exact authenticated Copilot provider/model family"),
		};
	}
	return enrichment;
}
