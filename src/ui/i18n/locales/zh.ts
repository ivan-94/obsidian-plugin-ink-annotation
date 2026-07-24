import type { LocaleCatalog } from '../locale-catalog';

export function createSimplifiedChineseCatalog(
  formatNumber: (value: number) => string,
): LocaleCatalog {
  return {
    'sidebar.selectedCount': ({ count }) => `已选择 ${formatNumber(count)} 项`,
  };
}
