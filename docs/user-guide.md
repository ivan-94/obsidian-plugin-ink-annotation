# Inkstone Annotations 使用说明

## 安装与升级

发布候选包只包含 `main.js`、`manifest.json`、`styles.css` 和校验用的
`checksums.json`。手工安装时，将前三个运行时文件复制到：

```text
<Vault>/.obsidian/plugins/inkstone-annotations/
```

然后在 Obsidian 的第三方插件设置中启用 Inkstone
Annotations。升级前先关闭插件，并备份插件目录与 Vault 根目录下的
`.obsidian-annotations/`。覆盖三个运行时文件后重新启用。

回滚时恢复之前版本的三个运行时文件。当前 `0.1.x` 使用 canonical schema
v1；不要用旧版插件打开未来版本已经迁移的数据，除非该版本的发布说明明确兼容。

## 文字标注

- Reading View：选择受支持的正文文本后，使用悬浮工具条选择颜色、下划线或添加笔记。
- 相邻同类型的简单块（例如段落到段落）可作为一条标注，渲染时会拆成各块内部的局部fragment；跨段落/列表等不同复杂块类型仍会明确拒绝，避免破坏 Markdown
  DOM。
- Live Preview：选择文本后使用同一悬浮工具条；也可运行 `Apply last highlight to selection` 和
  `Add note to selection` 命令。
- 点击正文标注、侧栏条目或 note-only 标记可打开 Inspector，编辑样式、正文和标签。
- 锚点无法唯一恢复时会显示为
  `unanchored`，不会静默绑定到猜测文本。使用 Inspector 的 repair 流程预览并确认新目标。

## Ink Mode

- 运行 `Toggle Ink Mode` 进入或退出；`Exit Ink Mode` 可强制退出。
- 支持 Pen、Highlighter、整笔 Eraser、Color、Width、Undo、Redo。
- Ink 绑定到有界 Markdown section surface。版式变化时可能进入
  `needs-rebase`，必须预览并确认；取消不会覆盖原 vector 数据。
- 本设备最后使用的工具、颜色和粗细保存在设备 local storage，不通过 iCloud 同步。

## 侧栏与导出

- `Open annotations for current file` 打开侧栏；可切换当前文件和 Entire Vault。
- 当前文件支持文字标注和 Ink 缩略图、定位、编辑、删除/恢复和导出。
- Entire Vault 会懒加载文字与 Ink 的派生索引。Ink 只进入标题、状态、revision、stroke
  count 等列表元数据，vector
  points 与缩略图 SVG 不会进入全库索引。可搜索、筛选、定位、复制、按 revision 安全删除，并与文字记录一起导出；批量标签和样式只适用于文字记录。
- 发现同一文字标注或 Ink surface 的 iCloud 同 revision 冲突时，侧栏会显示
  `Review conflicts`。逐项比较设备、时间、内容或 Ink 缩略图后，必须明确选择一个副本；插件会写入更高 revision，并保留所有原冲突文件。若候选在确认前变化，保存会失败并要求重新审阅。
- 文字可导出为 standalone Markdown report、Markdown highlight、footnote 或 HTML mark。
- Ink 可导出 SVG、PNG 或 standalone HTML report。
- 导出写入 `Inkstone Exports/`，同名文件使用数字后缀，绝不覆盖已有导出。

## 卸载

禁用或删除插件目录不会删除 `.obsidian-annotations/` canonical sidecars，也不会删除
`Inkstone Exports/`。若要彻底移除数据，请先备份/导出，再由用户手工删除这些目录；插件不提供自动销毁 canonical 数据的命令。

## 本地诊断

诊断默认关闭。显式启用后可运行 `Show diagnostics` 查看本地 timing；在 Ink
Mode 绘制时还会显示最近最多 240 个 input-to-paint 样本的 P50、P95、最大值和样本数。运行
`Capture memory diagnostics checkpoint` 可在空闲、长文档、Entire Vault 或 Ink
Mode 状态记录 Chromium 暴露的 JS heap MB 值。若当前 Obsidian runtime 不支持
`performance.memory`，插件会明确显示 unavailable。诊断不记录正文、路径、笔迹 points，也不会上传数据。
