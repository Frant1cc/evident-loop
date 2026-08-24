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
