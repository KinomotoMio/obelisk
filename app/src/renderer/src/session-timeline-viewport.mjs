import { computed, ref } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';

function estimatedTextHeight(text = '') {
  return Math.min(560, Math.ceil(String(text).length / 72) * 20);
}

export function estimateTimelineItemSize(item) {
  if (!item) return 96;
  if (item.kind === 'meta') return 34;
  if (item.kind === 'thinking') return 38;
  if (item.kind === 'skill') return 84;
  if (item.kind === 'workflow') {
    const agents = item.workflowCall?.workflow?.agents?.length || 0;
    return 72 + Math.min(360, agents * 34);
  }
  if (item.kind === 'workflow-tools') {
    return 48 + (item.toolCalls?.length || 0) * 38;
  }
  const message = item.message || {};
  return 72
    + estimatedTextHeight(message.text)
    + (message.tool_calls?.length || 0) * 38
    + (message.summary ? 34 : 0)
    + (message._thinking ? 34 : 0);
}

export function useSessionTimelineViewport({
  items,
  scrollElement,
  scrollMargin,
  overscan = 6,
  gap = 14,
  scrollPaddingEnd = 0,
}) {
  const followOnAppend = ref(false);
  const virtualizer = useVirtualizer(computed(() => ({
    count: items.value.length,
    getScrollElement: () => scrollElement.value,
    estimateSize: index => estimateTimelineItemSize(items.value[index]),
    getItemKey: index => items.value[index]?.key || index,
    scrollMargin: scrollMargin.value,
    scrollPaddingEnd,
    overscan,
    gap,
    anchorTo: 'end',
    followOnAppend: followOnAppend.value,
    scrollEndThreshold: 50,
    useAnimationFrameWithResizeObserver: true,
  })));

  const virtualRows = computed(() => virtualizer.value.getVirtualItems());
  const totalSize = computed(() => virtualizer.value.getTotalSize());
  const isScrolling = computed(() => virtualizer.value.isScrolling);

  function measureElement(element) {
    if (!element) return;
    virtualizer.value.measureElement(element);
  }

  function indexAtViewportEnd(inset = 0) {
    const instance = virtualizer.value;
    const viewportSize = instance.scrollRect?.height || scrollElement.value?.clientHeight || 0;
    const offset = (instance.scrollOffset || scrollElement.value?.scrollTop || 0)
      + viewportSize
      - inset;
    return instance.getVirtualItemForOffset(offset)?.index ?? 0;
  }

  function runWithMeasurementRetry(scroll) {
    scroll();
    const targetWindow = scrollElement.value?.ownerDocument?.defaultView;
    targetWindow?.requestAnimationFrame(() => {
      targetWindow.requestAnimationFrame(scroll);
    });
  }

  function scrollToIndex(index, options = {}) {
    const scroll = () => {
      virtualizer.value.scrollToIndex(index, { behavior: 'auto', ...options });
    };

    // A far jump starts from estimates. Re-align after mounted rows have been
    // measured so the requested item does not remain only in overscan.
    runWithMeasurementRetry(scroll);
  }

  function scrollToEnd() {
    const scroll = () => {
      const element = scrollElement.value;
      if (element && 'scrollHeight' in element) {
        element.scrollTo({ top: element.scrollHeight, behavior: 'auto' });
      } else {
        virtualizer.value.scrollToEnd({ behavior: 'auto' });
      }
    };
    runWithMeasurementRetry(scroll);
  }

  function isFollowingTail() {
    if (!followOnAppend.value) return false;
    const element = scrollElement.value;
    if (element && 'scrollHeight' in element) {
      return element.scrollHeight - element.clientHeight - element.scrollTop <= 50;
    }
    return virtualizer.value.isAtEnd(50);
  }

  function resetForInitialSnapshot() {
    followOnAppend.value = false;
    virtualizer.value.scrollToOffset(0, { behavior: 'auto' });
  }

  function completeInitialSnapshot() {
    followOnAppend.value = true;
  }

  return {
    virtualRows,
    totalSize,
    isScrolling,
    measureElement,
    indexAtViewportEnd,
    scrollToIndex,
    scrollToEnd,
    isFollowingTail,
    resetForInitialSnapshot,
    completeInitialSnapshot,
  };
}
