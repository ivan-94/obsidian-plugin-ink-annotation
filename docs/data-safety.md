# Data Safety and iCloud Model

## Canonical 与派生数据

- Canonical：`.obsidian-annotations/v1/notes/<path-hash>/` 下的 note metadata、每条文字 annotation
  JSON 和每个 Ink surface JSON。
- 派生：Vault `index.json`、note summary、Ink thumbnail summary。派生文件可删除并从 canonical 重建。
- 插件卸载、cache clear、index rebuild 或 UI 错误不得删除 canonical 文件。

## iCloud 冲突策略

- 每条记录独立文件、UUID identity、单调 revision、device ID 和保守 tombstone。
- 同一 UUID 的多个 iCloud artifacts 全部保留；插件选择最高 revision 用于只读展示。
- 相同最高 revision 但内容不同属于显式 conflict，禁止自动覆盖。文字记录与 Ink
  surface 都必须由用户在侧栏逐项比较并明确选择一个候选；插件重新读取候选并写入更高 canonical
  revision，原冲突文件不会删除。Ink 审阅只在打开冲突流程时加载完整候选 vector，普通索引不加载。
- 本地写入只表示 `Saved locally`，不表示已经同步到其他设备。
- Obsidian 报告 canonical sidecar create/modify/delete 时，派生 Ink
  summary 会从 canonical 重建；Entire Vault 视图会重新扫描 canonical notes。

## 删除与保留

文字和 Ink 删除默认写 tombstone，并保留目标、笔记、标签、样式和 vector 数据以支持恢复及迟到设备合并。v1 没有自动 tombstone 清理；这是防止 iCloud 延迟复活旧数据的保守默认。未来若增加清理，必须有明确保留期、备份和跨设备水位决策。

## 故障恢复

1. Canonical 更新先写入并回读校验临时文件，再通过同目录 temporary/backup
   journal 提升。重启后，完整 target 优先；target 缺失时恢复 backup；只有未提升 temporary 的新建会被丢弃，避免把半记录当成 canonical。这是应用级恢复策略，不代表 iCloud/OS 提供全局原子事务。
2. 不要在文件系统中手工合并或覆盖同 UUID 的冲突 JSON；优先使用侧栏的
   `Review conflicts`。确认前候选发生变化时，插件会拒绝陈旧选择并要求重新审阅。
3. 先复制整个 `.obsidian-annotations/` 作为只读备份。
4. 删除派生 `index.json` 或 summary 是安全的；下次打开相关视图会重建。
5. 损坏的单个 record 会隔离并报告，健康 sibling 继续可见。
6. Markdown rename/move 通过 source fingerprint 对账；多候选时失败关闭并要求人工处理。
7. 导出是可移植快照，不是 canonical round-trip 导入格式。

## 隐私

插件没有 telemetry、账号或外部服务。诊断只保留本地聚合 timing、最近最多 240 个 input-to-paint
duration 和可选的 JS heap MB 总量，不包含路径、文字内容、pointer 坐标或 Ink
points。annotation 内容仍会像 Vault 其他文件一样由用户选择的 iCloud 设置同步。
