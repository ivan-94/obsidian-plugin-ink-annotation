import type { LocaleCatalog } from '../locale-catalog';

export function createSimplifiedChineseCatalog(
  formatNumber: (value: number) => string,
): LocaleCatalog {
  return {
    'command.addNote': () => '为所选文字添加笔记',
    'command.applyHighlight': () => '将上次使用的高亮应用到所选文字',
    'command.captureSnapshot': () => '截取并标注当前阅读视图',
    'command.openAnnotations': () => '打开当前文件的标注',
    'command.reopenSnapshot': () => '重新打开最近的截图标注',
    'command.resumeSnapshotDraft': () => '继续最近的截图标注草稿',
    'command.selectSnapshotBackend': ({ label }) => `截图验收：使用 ${label} 后端`,
    'command.showDiagnostics': () => '显示诊断信息',
    'command.undoAnnotationDelete': () => '撤销上次删除标注',
    'notice.annotationLinkIncomplete': () => '标注链接缺少文件或标注 ID。',
    'notice.annotationMissing': () => '链接的标注不存在或已被删除。',
    'notice.annotationRepairDifferentFile': () => '请在该标注所在的同一篇笔记中选择替换文字。',
    'notice.annotationRepairFailed': () => '无法准备修复，原始目标未发生变化。',
    'notice.annotationRepairNotNeeded': () => '此标注已不需要修复。',
    'notice.annotationRepairUnavailable': () => '此标注已无法修复。',
    'notice.backgroundCleanupFailed': ({ count }) =>
      `Inkstone 无法清理 ${formatNumber(count)} 个后台任务。`,
    'notice.captureSnapshotFailed': () => '截图标注截取失败。',
    'notice.capturingReadingView': () => '正在截取当前阅读视图…',
    'notice.diagnosticsDisabled': () => '诊断功能已关闭，请在 Inkstone Annotations 设置中启用。',
    'notice.exportedInkPng': ({ path }) => `Ink PNG 已导出到 ${path}`,
    'notice.exportedInkReport': ({ path }) => `Ink 报告已导出到 ${path}`,
    'notice.exportedInkSvg': ({ path }) => `Ink SVG 已导出到 ${path}`,
    'notice.exportedSnapshotPng': ({ path }) => `展平后的截图 PNG 已导出到 ${path}`,
    'notice.highlightSaveFailed': () => '无法在本地保存高亮，请重试。',
    'notice.noAnnotationDeleteToUndo': () => '没有可撤销的标注删除操作。',
    'notice.noSnapshotDraft': () => '当前文件没有截图标注草稿。',
    'notice.noSnapshotToReopen': () => '当前文件没有已保存的截图标注。',
    'notice.noTimingSamples': () => '暂无耗时样本。',
    'notice.noteDraftFailed': () => '无法创建本地笔记草稿，请重试。',
    'notice.openSidebarFailed': () => '无法打开标注侧栏。',
    'notice.selectReplacementReadingView': () => '请先在阅读视图中选择支持的替换文字。',
    'notice.selectSupportedText': () => '请先在阅读视图或实时预览中选择支持的文字。',
    'notice.snapshotBackendSelected': ({ label }) => `截图截取后端：${label}`,
    'notice.snapshotDraftReopenFailed': () => '重新打开截图标注草稿失败。',
    'notice.snapshotExportFromCard': () => '请从截图标注卡片菜单导出。',
    'notice.snapshotRelinkFailed': () => '重新关联截图标注失败。',
    'notice.snapshotReopenFailed': () => '重新打开截图标注失败。',
    'notice.snapshotSourceUnavailable': () => '截图来源不可用，请先重新关联。',
    'notice.undoAnnotationDeleteFailed': () => '无法在本地撤销标注删除，请重试。',
    'snapshot.captureAction': () => '截取并标注',
    'snapshot.capturingAction': () => '正在截取阅读视图',
    'settings.cleanup.button': () => '清理缓存',
    'settings.cleanup.cleaning': () => '正在清理…',
    'settings.cleanup.confirm': ({ eligibleCount, heldCount }) => {
      const held =
        heldCount === 0 ? '' : `\n\n另有 ${formatNumber(heldCount)} 条冲突或损坏数据会被保留。`;
      return `将永久删除 ${formatNumber(eligibleCount)} 条已删除的文字标注。此操作无法撤销。${held}`;
    },
    'settings.cleanup.description': () =>
      '永久清理已删除的高亮和文字笔记。冲突或损坏的数据会保留；Ink 与截图标注暂不包含在本次清理中。',
    'settings.cleanup.failure': () => '缓存清理失败。',
    'settings.cleanup.name': () => '清理缓存',
    'settings.cleanup.noEligible': ({ heldCount }) =>
      heldCount === 0
        ? '没有可清理的文字标注缓存。'
        : `${formatNumber(heldCount)} 条文字标注因冲突或损坏而保留。`,
    'settings.cleanup.scanning': () => '正在扫描…',
    'settings.cleanup.success': ({ removedCount, retainedCount }) =>
      `缓存清理完成：已永久删除 ${formatNumber(removedCount)} 条文字标注；${formatNumber(retainedCount)} 条因冲突或损坏而保留。`,
    'settings.diagnostics.description': () =>
      '保留本地耗时样本。标注文字、墨迹点和文件路径绝不会被记录。',
    'settings.diagnostics.name': () => '诊断',
    'settings.style.namePlaceholder': () => '样式名称',
    'settings.style.stableId': ({ id }) => `稳定样式 ID：${id}`,
    'sidebar.selectedCount': ({ count }) => `已选择 ${formatNumber(count)} 项`,
  };
}
