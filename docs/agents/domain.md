# Domain docs

采用 single-context：根目录 `GLOSSARY.md` 保存领域词汇，`docs/adr/` 保存架构决策。按需创建，当前没有内容时不建空文件。

- 探索前读取已有词汇表和与本任务相关的 ADR；文件不存在则继续。
- 命名、issue、测试与设计说明使用词汇表的术语；缺失或矛盾的术语交由 domain-modeling 澄清。
- 提案与已有 ADR 冲突时，明确指出决策及重开的理由。
- 现有设计规格、协议及运维文档仍是对应事项的依据；不为适配技能复制成第二份 ADR。
- 若以后出现根目录 `GLOSSARY-MAP.md`，改按 map 加载相关领域的词汇表和 ADR。
