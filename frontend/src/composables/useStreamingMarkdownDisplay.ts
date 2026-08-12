import { shallowRef, watch, type Ref } from 'vue';

import {
  advance,
  createDetectorState,
  finalize,
  type Segment
} from '../markdown/structuredBlockDetector';

/**
 * Feeds a growing Markdown string through the structured-block detector and
 * exposes the ordered segments for rendering. Detector state is kept outside
 * Vue's reactivity (it is mutated in place); `segments` is a shallowRef swapped
 * on each pass so the template re-renders while frozen segments keep identity.
 *
 * Resets when `content` stops being an append-only growth of what was seen
 * (e.g. the message was replaced), keeping the id counter monotonic so a stale
 * keyed node can never collide with a fresh one.
 */
export function useStreamingMarkdownDisplay(
  content: Ref<string>,
  streaming: Ref<boolean>
): { segments: Ref<Segment[]> } {
  const segments = shallowRef<Segment[]>([]);
  let state = createDetectorState();
  let previousContent = '';
  let finalized = false;

  const recompute = (value: string, isStreaming: boolean) => {
    if (!value.startsWith(previousContent)) {
      const seq = state.seq;
      state = createDetectorState();
      state.seq = seq;
      finalized = false;
    }
    previousContent = value;

    advance(state, value);
    if (!isStreaming && !finalized) {
      finalize(state);
      finalized = true;
    }
    segments.value = state.segments.slice();
  };

  watch(
    () => [content.value, streaming.value] as const,
    ([value, isStreaming]) => recompute(value, isStreaming),
    { immediate: true }
  );

  return { segments };
}
