import type { LocaleCatalog } from '../locale-catalog';

export function createEnglishCatalog(formatNumber: (value: number) => string): LocaleCatalog {
  return {
    'sidebar.selectedCount': ({ count }) => `${formatNumber(count)} selected`,
  };
}
