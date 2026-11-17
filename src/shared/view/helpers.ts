import type { AssetResolver } from './assets.js';

interface HelperDeps {
  assets: AssetResolver;
}

/**
 * Handlebars helpers (ADR 0014). Every helper returns a plain string that Handlebars escapes; none returns HTML.
 * Phase 1b adds `eq`, `plural`, `formatCount`, `formatDate`, `cityPath`, `pagePath`, `fieldId` and `currentAttr`.
 */
export function createHelpers({ assets }: HelperDeps) {
  return {
    /** `{{asset "app.css"}}` -> `/assets/app-<hash>.css` (production) or `/assets/app.css` (development). */
    asset: (logicalName: unknown): string => {
      if (typeof logicalName !== 'string') throw new TypeError('asset: expects a logical asset name');
      return assets(logicalName);
    },
  };
}
