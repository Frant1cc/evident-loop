import { ref } from 'vue';

export type DemoStatus = {
  enabled: boolean;
  dailyLimit?: number;
  remaining?: number;
  resetsAt?: string;
  maxMessageChars?: number;
};

export const demoStatus = ref<DemoStatus>({ enabled: false });

export async function refreshDemoStatus() {
  const response = await fetch('/api/demo', { credentials: 'same-origin', cache: 'no-store' });
  const payload = await response.json() as { code: number; message: string; data: DemoStatus };
  if (!response.ok || payload.code !== 1) throw new Error(payload.message || '无法加载体验信息，请刷新页面重试。');
  demoStatus.value = payload.data;
}
