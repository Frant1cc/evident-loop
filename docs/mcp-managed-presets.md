# 托管 MCP 预置架构文档

## 概述

托管 MCP 预置是一套后端管理的内置 MCP 连接，提供一键启用功能。与前端表单模板不同，托管预置由后端统一管理，提供跨平台支持、固定版本和本地审批策略。

## 架构设计

### 组件层次

```
Frontend UI
  └─ McpManagementView
      ├─ McpPresetCard (预置卡片)
      └─ PresetConsentDialog (确认弹窗)
          ↓
Backend API
  └─ /api/mcp/presets
      ├─ GET /presets (列出预置)
      ├─ POST /presets/:id/enable (一键启用)
      └─ POST /presets/:id/disable (停用)
          ↓
McpManager
  ├─ listPresets() (关联状态)
  ├─ enablePreset() (核心逻辑)
  └─ disablePreset()
          ↓
Preset Catalog
  ├─ context7Preset
  ├─ memoryPreset
  └─ resolveDraft(platform) (跨平台命令)
          ↓
McpStore
  ├─ saveManagedMetadata()
  ├─ getManagedMetadata()
  └─ findServerByPresetId() (唯一性)
```

### 核心数据结构

#### McpManagedMetadata

```typescript
type McpManagedMetadata = {
  presetId: string;           // 'context7' | 'memory'
  presetVersion: number;      // 预置配置版本
  consentVersion: number;     // 用户确认版本
  consentedAt: string;        // ISO 8601 时间戳
};
```

持久化到 `config_json` 字段，扩展现有的 `StoredConfig` 结构。

#### ManagedMcpPreset

```typescript
type ManagedMcpPreset = {
  id: string;
  version: number;
  consentVersion: number;
  name: string;
  description: string;
  publisher: string;
  package: { name: string; version: string };
  resolveDraft: (platform: NodeJS.Platform) => McpServerDraft;
  approvalPolicy: ManagedMcpApprovalPolicy;
};
```

## 核心流程

### 一键启用流程

```
用户点击"启用"
  ↓
前端弹出确认对话框
  ├─ 显示预置信息（包名、版本、发布者）
  ├─ 显示审批策略说明
  └─ 数据说明（发送对话上下文）
  ↓
用户确认
  ↓
POST /api/mcp/presets/:id/enable
  ↓
enablePreset(presetId, consentVersion)
  1. 验证预置存在
  2. 检查 consentVersion
  3. 解析平台配置 (npx vs npx.cmd)
  4. 查找或创建唯一 Server (by presetId)
  5. 幂等检查：已连接 → 直接返回
  6. testServer (验证连接)
  7. setEnabled(true)
  8. 轮询等待 connected (30秒超时)
  ↓
返回已连接的 Server 状态
  ↓
前端显示"已启用，下一轮对话生效"
```

### 跨平台命令解析

**Windows:**
```javascript
command: 'npx.cmd'
args: ['--yes', '@upstash/context7-mcp@0.1.5']
```

**macOS/Linux:**
```javascript
command: 'npx'
args: ['--yes', '@upstash/context7-mcp@0.1.5']
```

**安全验证:**
- 命令白名单：只允许 `npx` 和 `npx.cmd`
- 参数检查：拒绝包含 `;`, `&`, `|`, `` ` ``, `$`, `()`, `{}` 的参数
- 禁止 `shell: true`

## 审批策略

### 优先级

```
1. 本地工具级策略 'require_approval' → 必须审批
2. 本地工具级策略 'allow' → 免审批
3. 预置默认 'allow_readonly' + 远端 readOnlyHint: true → 免审批
4. 其他 → 默认审批
```

### 预置策略示例

**Context7:**
```typescript
{
  default: 'allow_readonly',
  tools: {
    'query-docs': 'allow',
    'resolve-library-id': 'allow'
  }
}
```

**Memory:**
```typescript
{
  default: 'require_approval',
  tools: {
    'query_memory': 'allow',
    'store_memory': 'require_approval'
  }
}
```

## 向后兼容

### 数据库兼容

- 无需迁移：利用 `config_json` TEXT 字段扩展
- 旧记录：没有 `managedMetadata` 字段的记录视为自定义 MCP Server
- 新记录：包含 `managedMetadata` 字段的记录为托管预置

### API 兼容

- 现有 `/api/mcp/servers` 端点保持不变
- 新增 `/api/mcp/presets` 端点独立于现有 API
- 自定义 MCP Server 不受影响

## 幂等性保证

### 重复启用

1. 通过 `presetId` 查找唯一 Server
2. 已存在且已连接 → 立即返回当前状态
3. 已存在但未连接 → 重新测试和启用
4. 不存在 → 创建新 Server

### 并发保护

- 单飞 Promise：同一预置的并发启用请求复用同一个 Promise
- 数据库唯一性：`findServerByPresetId()` 确保只返回一个 Server

## 错误处理

### 错误类型

- `404` - 预置不存在
- `409` - 确认版本过期
- `502` - 测试失败（连接失败、工具发现失败）
- `504` - 启用超时（30秒内未连接）

### 恢复策略

- 测试失败：保持 `enabled: false`，保留 LKG
- 超时：记录错误，用户可重试
- 包下载失败：清晰错误提示，建议检查网络或 npm 配置

## 安全边界

### 命令执行

- 白名单验证：只允许 `npx` 和 `npx.cmd`
- 参数验证：拒绝包含 shell 元字符的参数
- 固定版本：防止包替换攻击
- 无 shell：不使用 `shell: true`

### 审批决策

- 本地策略优先：不信任远端 `readOnlyHint`
- 工具级覆盖：允许为特定工具设置策略
- 默认保守：未知工具默认需要审批

### 数据隔离

- stdio 仅回环：stdio MCP Server 只能在 loopback host 上运行
- 凭证加密：敏感凭证使用 AES-256-GCM 加密
- API 不暴露：公开 API 不返回命令、环境变量或凭证

## 性能考虑

### 启用性能

- 目标：30秒内完成
- 轮询间隔：500ms
- 超时：30秒

### 重启恢复

- 应用重启时自动恢复已启用的预置连接
- 无需重新下载包（npx 缓存）
- 无需用户重新确认

## 测试策略

### 单元测试

- 平台解析：Windows/macOS/Linux 命令正确性
- 命令安全：拒绝危险字符
- 幂等性：重复启用不创建多实例
- 元数据持久化：保存和读取

### 集成测试

- 完整启用流程：mock npx
- API 端到端：请求和响应格式
- 审批策略：本地策略优先级

### 手工验收

- [ ] macOS + Node 20
- [ ] Windows + Node 20
- [ ] Linux + Node 20
- [ ] 无网络场景
- [ ] 并发启用

## 相关文件

### 后端

- `backend/src/mcp/presets/contracts.ts` - 类型定义
- `backend/src/mcp/presets/platform.ts` - 平台解析
- `backend/src/mcp/presets/catalog.ts` - 预置定义
- `backend/src/mcp/manager.ts` - 核心逻辑
- `backend/src/mcp/store.ts` - 持久化
- `backend/src/mcp/routes.ts` - API 路由

### 前端

- `frontend/src/types/mcp-presets.ts` - 类型
- `frontend/src/api/mcp.ts` - API 客户端
- `frontend/src/components/mcp/McpPresetCard.vue` - 卡片
- `frontend/src/components/mcp/PresetConsentDialog.vue` - 弹窗
- `frontend/src/views/McpManagementView.vue` - 主视图

## 参考

- [MCP 包版本记录](./mcp-package-versions.md)
- [内置 MCP 一键启用技术方案](./built-in-mcp-one-click-enablement.md)
