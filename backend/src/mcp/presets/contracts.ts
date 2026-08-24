import type { McpServerDraft } from '../contracts.js';

/**
 * 托管预置元数据（持久化到 config_json）
 */
export type McpManagedMetadata = {
  presetId: string;
  presetVersion: number;
  consentVersion: number;
  consentedAt: string;
};

/**
 * 托管预置审批策略
 */
export type ManagedMcpApprovalPolicy = {
  default: 'require_approval' | 'allow_readonly';
  tools?: Record<string, 'require_approval' | 'allow'>;
};

/**
 * 托管预置定义（后端内部）
 */
export type ManagedMcpPreset = {
  id: string;
  version: number;
  consentVersion: number;
  name: string;
  description: string;
  publisher: string;
  package: {
    name: string;
    version: string;
  };
  resolveDraft: (platform: NodeJS.Platform) => McpServerDraft;
  approvalPolicy: ManagedMcpApprovalPolicy;
};

/**
 * 预置公开信息（API 返回）
 */
export type McpPresetPublic = {
  id: string;
  name: string;
  description: string;
  publisher: string;
  package: {
    name: string;
    version: string;
  };
  consentVersion: number;
  status: 'not_installed' | 'disabled' | 'connecting' | 'connected' | 'unavailable' | 'authorization_required' | 'credential_unavailable' | 'error';
  serverId?: string;
  enabled: boolean;
  lastError?: string;
  lastRefreshedAt?: string;
  toolCount: number;
  approvalPolicyDescription: string;
};
