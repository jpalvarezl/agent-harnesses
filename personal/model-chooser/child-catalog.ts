import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { ModelIdentity } from "./index.ts";

let childCatalogPromise: Promise<readonly ModelIdentity[] | undefined> | undefined;

async function loadFreshChildCatalog(): Promise<readonly ModelIdentity[] | undefined> {
	try {
		const runtime = await ModelRuntime.create({ allowModelNetwork: false });
		// create() has already restored the local auth/catalog snapshot. Avoid an
		// additional async availability refresh in this hot-path safety check.
		const models = runtime.getAvailableSnapshot();
		return models.map((model) => ({ provider: model.provider, id: model.id, name: model.name }));
	} catch {
		// Unknown must remain distinct from an empty, successfully loaded catalog.
		// Chooser-enabled child selection treats unknown resolvability as ineligible.
		return undefined;
	}
}

/**
 * Load an extension-free child-runtime catalog once per Pi process. Successful
 * results are cached; an unknown/transient failure is cleared so a later call
 * can recover without restarting Pi.
 */
export function getFreshChildCatalog(): Promise<readonly ModelIdentity[] | undefined> {
	childCatalogPromise ??= loadFreshChildCatalog().then((catalog) => {
		if (catalog === undefined) childCatalogPromise = undefined;
		return catalog;
	});
	return childCatalogPromise;
}
