# MCP 包版本记录

本文档记录了项目中使用的托管 MCP 预置包的版本信息和审计历史。

## 当前版本

| 预置 | 包名 | 当前版本 | 最后审计 | 审计人 | 备注 |
|------|------|----------|----------|--------|------|
| Context7 | @upstash/context7-mcp | 4.0.3 | 2026-08-25 | - | 已核对 npm registry |
| Memory | @modelcontextprotocol/server-memory | 2026.7.4 | 2026-08-25 | - | 已核对 npm registry |

## 升级流程

升级托管预置包时，请遵循以下流程：

1. **测试新版本**
   - 在本地测试环境验证新版本
   - 确认工具定义和行为符合预期
   - 检查是否有破坏性变更

2. **更新代码**
   - 修改 `backend/src/mcp/presets/catalog.ts` 中的版本号
   - 如有权限或数据边界变化，增加 `consentVersion`
   - 更新审批策略（如有变化）

3. **记录到本文档**
   - 更新上方表格的版本和审计日期
   - 在版本历史中添加记录

4. **代码审查**
   - 提交 PR 并标注包升级的原因
   - 至少一位团队成员审核

## 版本历史

### 2026-08-25

**Context7 4.0.3**
- 修复不存在的初始版本 `0.1.5`
- npm 7+ 使用 `npx --yes @upstash/context7-mcp@4.0.3`；npm 6 使用其非交互兼容形式 `npx @upstash/context7-mcp@4.0.3`
- 审批策略：只读工具自动允许

**Memory 2026.7.4**
- 修复不存在的初始版本 `0.1.0`
- npm 7+ 使用 `npx --yes @modelcontextprotocol/server-memory@2026.7.4`；npm 6 使用其非交互兼容形式 `npx @modelcontextprotocol/server-memory@2026.7.4`
- 审批策略：读取允许，写入需要审批

## 版本策略说明

托管预置始终使用经过验证的固定版本。升级时递增 `presetVersion`；Manager 会在下一次启用时先把已有 Server 的命令迁移到新版本，再重新测试。涉及权限或数据边界变化时还必须递增 `consentVersion`，要求用户重新确认。

## 安全注意事项

1. **固定版本**：始终使用固定版本号，避免使用 `latest` 或版本范围
2. **定期审计**：每季度检查一次是否有安全更新或重要 bug 修复
3. **来源验证**：确认包来自官方发布渠道
4. **依赖审查**：检查包的传递依赖是否有已知漏洞

## 相关文档

- [托管预置架构文档](./mcp-managed-presets.md)
- [MCP 管理文档](../README.md)
