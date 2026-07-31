import { ref, watch, type Ref } from 'vue';

/** A side panel never takes more than this share of the viewport, so dragging cannot squeeze the main column away. */
const MAX_VIEWPORT_RATIO = 0.4;

export interface PanelWidthBounds {
  defaultWidth: number;
  min: number;
  max: number;
}

/** Clamp a dragged width to the panel's own bounds and to a sane share of the current viewport. */
export function clampPanelWidth(value: number, min: number, max: number) {
  const viewportMax = typeof window === 'undefined' ? max : window.innerWidth * MAX_VIEWPORT_RATIO;
  const upperBound = Math.max(min, Math.min(max, viewportMax));
  return Math.round(Math.min(upperBound, Math.max(min, value)));
}

/**
 * A panel width that survives reloads. The stored value is only clamped against the panel's own
 * bounds, so a width chosen on a wide screen is not permanently shrunk by opening a narrow window.
 */
export function useResizablePanel(storageKey: string, bounds: PanelWidthBounds): Ref<number> {
  const { defaultWidth, min, max } = bounds;
  const stored = readStoredWidth(storageKey);
  const width = ref(Math.round(Math.min(max, Math.max(min, stored ?? defaultWidth))));

  watch(width, (value) => {
    try {
      window.localStorage.setItem(storageKey, String(value));
    } catch {
      // Remembering the width is a convenience; ignore unavailable or full storage.
    }
  });

  return width;
}

/** A collapsed/expanded panel state that survives reloads, stored alongside the panel widths. */
export function useCollapsiblePanel(storageKey: string, defaultCollapsed = false): Ref<boolean> {
  const collapsed = ref(readStoredFlag(storageKey) ?? defaultCollapsed);

  watch(collapsed, (value) => {
    try {
      window.localStorage.setItem(storageKey, value ? '1' : '0');
    } catch {
      // Remembering the collapsed state is a convenience; ignore unavailable or full storage.
    }
  });

  return collapsed;
}

function readStoredFlag(storageKey: string) {
  try {
    const raw = window.localStorage.getItem(storageKey);
    return raw === null ? undefined : raw === '1';
  } catch {
    return undefined;
  }
}

function readStoredWidth(storageKey: string) {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return undefined;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
