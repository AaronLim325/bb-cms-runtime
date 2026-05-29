import type {
  CollectionDescriptor,
  CollectionMap,
  CollectionOptions,
} from "./types.js";

/**
 * Declare one CMS collection.
 *
 * @example
 * const services = defineCollection("services", { consumers: ["/", "/services"] });
 * const settings = defineCollection("settings", { consumers: ["/"], singleton: true });
 */
export function defineCollection(
  name: string,
  options: CollectionOptions,
): CollectionDescriptor {
  if (!name || !/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new Error(
      `[cms-runtime] Invalid collection name "${name}". Use lowercase letters, digits, "-" and "_".`,
    );
  }
  if (!Array.isArray(options.consumers)) {
    throw new Error(
      `[cms-runtime] Collection "${name}" must declare a "consumers" array (public route paths it renders).`,
    );
  }
  return Object.freeze({
    name,
    tag: options.tag ?? name,
    consumers: Object.freeze([...options.consumers]),
    singleton: options.singleton ?? false,
  });
}

/**
 * Build the keyed collection map consumed by {@link createCmsRoute},
 * {@link createReader}, etc. Throws on duplicate names so a copy-paste mistake
 * fails loudly at module load instead of silently shadowing.
 */
export function defineCollections(
  descriptors: readonly CollectionDescriptor[],
): CollectionMap {
  const map: CollectionMap = {};
  for (const d of descriptors) {
    if (map[d.name]) {
      throw new Error(`[cms-runtime] Duplicate collection name "${d.name}".`);
    }
    map[d.name] = d;
  }
  return map;
}

/** The empty/fallback value for a collection that has no Blob yet. */
export function emptyFor(descriptor: CollectionDescriptor): unknown {
  return descriptor.singleton ? {} : [];
}
