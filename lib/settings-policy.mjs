// Native Pi force-exclusions take precedence over explicit force-inclusions.
export const REQUIRED_EXTENSION_FILTERS = Object.freeze(["-builtin:mcp"]);

export function hasRequiredExtensionFilters(settings) {
  return Array.isArray(settings.extensions) && settings.extensions.every(entry => typeof entry === "string") &&
    REQUIRED_EXTENSION_FILTERS.every(entry => settings.extensions.includes(entry));
}
