export const configurableTabKeys = ['research', 'artifacts', 'tasks', 'evaluations', 'knowledge'] as const;

export type ConfigurableTabKey = (typeof configurableTabKeys)[number];
export type AppTabKey = ConfigurableTabKey | 'mcp' | 'settings';
export type TabVisibility = Record<ConfigurableTabKey, boolean>;

export const defaultTabVisibility: TabVisibility = {
  research: true,
  artifacts: true,
  tasks: true,
  evaluations: true,
  knowledge: true
};

const storageKey = 'evident-loop:tab-visibility';
const legacyStorageKey = 'agent-demo:tab-visibility';

export function loadTabVisibility(): TabVisibility {
  try {
    const storedValue =
      window.localStorage.getItem(storageKey) ??
      window.localStorage.getItem(legacyStorageKey) ??
      '{}';
    const saved = JSON.parse(storedValue) as Partial<TabVisibility>;

    return configurableTabKeys.reduce<TabVisibility>((visibility, key) => {
      visibility[key] = typeof saved[key] === 'boolean' ? saved[key] : defaultTabVisibility[key];
      return visibility;
    }, { ...defaultTabVisibility });
  } catch {
    return { ...defaultTabVisibility };
  }
}

export function saveTabVisibility(visibility: TabVisibility) {
  window.localStorage.setItem(storageKey, JSON.stringify(visibility));
}
