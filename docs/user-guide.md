# Inkstone Annotations 使用说明

## 安装与升级

`0.1.x` 是 Beta。发布候选包只包含 `main.js`、`manifest.json`、`styles.css` 和校验用的
`checksums.json`。手工安装时，将前三个运行时文件复制到：

```text
<Vault>/.obsidian/plugins/inkstone-annotations/
```

然后在 Obsidian 的第三方插件设置中启用 Inkstone
Annotations。升级前先关闭插件，并备份插件目录与 Vault 根目录下的
`.obsidian-annotations/`。覆盖三个运行时文件后重新启用。

Beta 也可以通过 BRAT 安装：在 BRAT 中选择 `Add Beta plugin`，填入
`https://github.com/ivan-94/obsidian-plugin-ink-annotation`，然后启用 Inkstone Annotations。

回滚时恢复之前版本的三个运行时文件。当前 `0.1.x` 使用 canonical schema
v1；不要用旧版插件打开未来版本已经迁移的数据，除非该版本的发布说明明确兼容。

移动端默认使用内嵌在 `main.js` 中的
`html-to-image`。插件不会从 CDN 下载这个库；捕获时会跳过 font 下载，把已经加载的 Vault 图片转为 data
URL，并将 remote 或 URL-backed 资源替换为占位，避免为了截图发起新的资源请求。

## 文字标注

- Reading View：选择受支持的正文文本后，使用悬浮工具条选择颜色、下划线或添加笔记。
- 相邻同类型的简单块（例如段落到段落）可作为一条标注，渲染时会拆成各块内部的局部fragment；跨段落/列表等不同复杂块类型仍会明确拒绝，避免破坏 Markdown
  DOM。
- Source mode 与 Live Preview 保持休眠，不提供文字标注创建。切回 Reading View 后，可使用悬浮工具条或
  `Apply last highlight to selection`、`Add note to selection` 命令。
- 点击正文标注、侧栏条目或 note-only 标记可打开 Inspector，编辑样式、正文和标签。
- 锚点无法唯一恢复时会显示为
  `unanchored`，不会静默绑定到猜测文本。使用 Inspector 的 repair 流程预览并确认新目标。

## 截图涂鸦

- 在 Reading
  View 使用相机入口截取当前可见内容，随后在稳定图片上涂鸦；Markdown 后续排版变化不会移动图片上的笔迹。
- 支持 Pen、Highlighter、整笔 Eraser、Color、Width、Undo、Redo，以及缩放和平移画布。
- 完成后，截图、笔迹与 Markdown 锚点一同写入 Vault-local sidecar；Current file 会立即出现对应卡片。
- 点击卡片进入只读预览，再点击画布或 `Edit` 进入编辑。Entire Vault 可跨文件搜索并定位截图涂鸦。
- 旧版 Live Markdown Ink 已停止创建和编辑。已有旧 Ink
  sidecar 不会被删除，仍可在侧栏中只读查看元数据并导出。

## 侧栏与导出

- `Open annotations for current file` 打开侧栏；可切换当前文件和 Entire Vault。
- 当前文件支持文字标注、截图涂鸦缩略图、定位、编辑、删除/恢复和导出；旧版 Ink 仅保留读取与导出兼容。
- Entire
  Vault 会懒加载文字、截图涂鸦与旧版 Ink 的派生索引。旧版 Ink 只进入标题、状态、revision、stroke
  count 等列表元数据，vector
  points 与缩略图 SVG 不会进入全库索引。可搜索、筛选、定位、复制、按 revision 安全删除，并与文字记录一起导出；批量标签和样式只适用于文字记录。
- 发现同一文字标注或 Ink surface 的 iCloud 同 revision 冲突时，侧栏会显示
  `Review conflicts`。逐项比较设备、时间、内容或 Ink 缩略图后，必须明确选择一个副本；插件会写入更高 revision，并保留所有原冲突文件。若候选在确认前变化，保存会失败并要求重新审阅。
- 文字可导出为 standalone Markdown report、Markdown highlight、footnote 或 HTML mark。
- Snapshot Annotation 导出为扁平化 PNG。只读兼容的旧版 Ink 可导出 SVG、PNG 或 standalone HTML
  report。
- 导出写入 `Inkstone Exports/`，同名文件使用数字后缀，绝不覆盖已有导出。

## 清理缓存

设置页中的 `清理缓存`
面向普通用户提供已删除文字标注的手动垃圾回收。点击后会先扫描并显示可清理数量，再要求确认永久删除。插件只处理无冲突、未损坏且 revision 未变化的文字 tombstone；先持久化并校验 graveyard 删除凭证，再删除完整 annotation
JSON。冲突、损坏或操作期间发生变化的数据会保留。

该操作目前不清理 Ink 或 Snapshot Annotation
tombstone，也不启用后台自动 GC。确认清理的文字标注无法 Restore；需要长期保留时应先导出或备份
`.obsidian-annotations/`。

## 卸载

禁用或删除插件目录不会删除 `.obsidian-annotations/` canonical sidecars，也不会删除
`Inkstone Exports/`。设置页 `清理缓存`
只回收已删除的安全文字 tombstone；若要彻底移除其余数据，请先备份/导出，再由用户手工删除这些目录。

## 本地诊断

诊断默认关闭。显式启用后可运行 `Show diagnostics`
查看本地 timing。诊断不记录正文、路径、笔迹 points，也不会上传数据。
