# Known Limitations and Non-Commitments

- `0.1.x`
  仍是 Beta。产品负责人已在本任务外完成人工验收并要求不重复执行；本次发布记录不会把该声明扩写为未提供的设备、版本、性能或无障碍证据。真实 Windows、Linux、Android、physical
  screen reader 与双真实设备同步矩阵仍应继续补齐。
- 移动端 `html-to-image` 已内嵌在
  `main.js`。捕获策略跳过 font 下载、内联已加载 Vault 图片，并替换 remote/URL-backed 资源；因此自定义主题的 URL
  background、mask 或 remote 图片在 Snapshot 中会显示为空或占位，而不是被重新下载。
- 文字标注创建限于 Reading View。Source mode 与 Live Preview 保持休眠，不安装文档标注交互面。
- 文字锚点只覆盖能够稳定投影回当前 Markdown source 的 Reading
  View 内容。歧义、生成内容、跨文件 transclusion，以及部分 math/code/复杂跨 block 选择会失败关闭；适合时可改用 Snapshot。
- Snapshot Annotation 捕获当前可见的 Reading View viewport，不是整篇文档截图、实时 Markdown
  overlay、PDF 标注或无限画布。
- Snapshot 保存的是不可变 capture
  PNG 和独立可编辑 strokes。Markdown、主题、字体或 pane 宽度后续变化不会重排旧截图，但也不会自动更新截图内容。
- 当前 Snapshot 工具包含 Pen、Highlighter、整笔 Eraser、Select/Move、Undo/Redo 和缩放/平移；不提供 line、arrow、shape
  recognition、OCR、手写识别或 Pencil double-tap/squeeze/hover。
- PDF、Canvas、网页 iframe 和任意第三方生成内容不是通用文字标注表面。capture
  backend 无法保真的节点必须显示受限占位或明确失败，不能静默消失。
- 旧版 Live Markdown
  Ink 已停止创建和编辑。已有旧 sidecar 仍保留读取、列表、冲突审阅与导出兼容，但不会自动转换为 Snapshot，因为缺少可信的原始 capture。
- 同步提供方没有应用级事务或可靠“已同步”回执。文字与旧版 Ink 的同 revision 分歧会暴露为冲突；Snapshot 当前采用 record-level
  Last Done Wins，不承诺逐 stroke 合并。
- 设置页 `清理缓存`
  只手动回收有 graveyard 保护、无冲突且 revision 未变化的文字 tombstone。旧版 Ink、Snapshot
  Annotation、冲突和损坏 payload 仍保守保留，不进行后台自动 GC。
- 导出格式用于阅读和迁移快照；当前不提供无损重新导入。
- 插件没有多人协作、云服务、账号、telemetry 或外部 OCR 服务。
