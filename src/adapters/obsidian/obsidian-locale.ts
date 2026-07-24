import * as Obsidian from 'obsidian';

import { normalizeLocale, type SupportedLocale } from '../../ui/i18n/create-i18n';

export interface ObsidianLocaleSource {
  readonly getLanguage?: () => string;
  readonly momentLocale: () => string;
}

export function resolveObsidianLocale(source: ObsidianLocaleSource): SupportedLocale {
  return normalizeLocale(source.getLanguage?.() ?? source.momentLocale());
}

export function getObsidianLocale(): SupportedLocale {
  const api = Obsidian as unknown as {
    readonly getLanguage?: () => string;
    readonly moment: { readonly locale: () => string };
  };
  return resolveObsidianLocale({
    ...(api.getLanguage === undefined ? {} : { getLanguage: api.getLanguage }),
    momentLocale: api.moment.locale,
  });
}
