# Known Limitations and Non-Commitments

- 当前 release candidate 尚未完成真实 iPad/Apple Pencil 验证；用户已要求暂时跳过该验证。
- 没有完成 Windows、physical screen reader 和双真实设备 iCloud
  HAT，不能称为正式发布；第三方主题 Minimal 8.2.1 已通过本地 macOS 兼容性验收，但不代表所有主题。
- Ink 只支持固定、有界 Markdown section
  surface；不是任意无限画布，也不承诺在所有主题和字体变化后保持像素级位置。
- 第一版不提供 line、arrow、lasso、shape recognition、Pencil double-tap/squeeze/hover。
- 普通编辑器不会叠加 Ink canvas；Ink 创建限于 Reading/Ink fixed-layout 模式。
- PDF、Canvas、网页嵌入、生成内容、跨不同复杂 block 类型的选择、部分 math/code 选择不属于稳定文字标注范围。同类型且能稳定映射的简单跨 block 选择会拆成局部 fragments。
- Live Preview 使用 canonical Markdown UTF-16
  offsets；IME 自动测试不能替代真实输入法和设备兼容验证。
- iCloud 没有应用级事务或可靠“已同步”回执。同记录冲突会暴露，不承诺自动合并正文、tags 或 strokes。
- v1 tombstone 无限期保留；当前没有自动垃圾回收。
- 导出格式用于阅读和迁移快照；当前不提供无损重新导入。
- 插件没有多人协作、云服务、OCR、手写识别或 PDF annotation 能力。
