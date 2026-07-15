import { computed, ref } from 'vue';
import { defaultRangeExtractor, elementScroll, useVirtualizer } from '@tanstack/vue-virtual';
import { createSessionTimelineScrollPolicy } from './session-timeline-scroll-policy.mjs';

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

export function createViewportRangeExtractor({
  getScrollElement,
  getVirtualizer,
  bufferViewports = 4,
}) {
  return range => {
    const element = getScrollElement();
    const instance = getVirtualizer();
    const viewportSize = element?.clientHeight || 0;
    if (!instance || viewportSize <= 0) return defaultRangeExtractor(range);

    // The compositor can advance wheel scrolling before the renderer receives
    // the scroll event. Buffer in pixels so short rows do not collapse a
    // count-based overscan into less than one trackpad gesture.
    const bufferSize = viewportSize * bufferViewports;
    const scrollOffset = element.scrollTop || 0;
    const first = instance.getVirtualItemForOffset(Math.max(0, scrollOffset - bufferSize));
    const last = instance.getVirtualItemForOffset(
      scrollOffset + viewportSize + bufferSize,
    );
    if (!first || !last) return defaultRangeExtractor(range);

    const startIndex = Math.max(0, Math.min(first.index, range.startIndex));
    const endIndex = Math.min(range.count - 1, Math.max(last.index, range.endIndex));
    return Array.from(
      { length: endIndex - startIndex + 1 },
      (_, offset) => startIndex + offset,
    );
  };
}

export function useSessionTimelineViewport({
  items,
  scrollElement,
  scrollMargin,
  overscan = 6,
  gap = 14,
  scrollPaddingEnd = 0,
  userScroll,
}) {
  const tailFollowReady = ref(false);
  const scrollPolicy = createSessionTimelineScrollPolicy({
    isUserScrolling: () => userScroll?.isActive() ?? false,
    writeScroll: elementScroll,
  });
  let virtualizer = null;
  const rangeExtractor = createViewportRangeExtractor({
    getScrollElement: () => scrollElement.value,
    getVirtualizer: () => virtualizer?.value,
  });
  virtualizer = useVirtualizer(computed(() => ({
    count: items.value.length,
    getScrollElement: () => scrollElement.value,
    estimateSize: index => estimateTimelineItemSize(items.value[index]),
    getItemKey: index => items.value[index]?.key || index,
    scrollMargin: scrollMargin.value,
    scrollPaddingEnd,
    overscan,
    rangeExtractor,
    gap,
    anchorTo: 'end',
    followOnAppend: false,
    scrollEndThreshold: 50,
    isScrollingResetDelay: 450,
    useScrollendEvent: true,
    useAnimationFrameWithResizeObserver: true,
    scrollToFn: scrollPolicy.scrollToFn,
  })));

  const virtualRows = computed(() => virtualizer.value.getVirtualItems());
  const totalSize = computed(() => virtualizer.value.getTotalSize());

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
      scrollPolicy.runExplicit(() => {
        virtualizer.value.scrollToIndex(index, { behavior: 'auto', ...options });
      });
    };

    // A far jump starts from estimates. Re-align after mounted rows have been
    // measured so the requested item does not remain only in overscan.
    runWithMeasurementRetry(scroll);
  }

  async function scrollToEnd() {
    const targetWindow = scrollElement.value?.ownerDocument?.defaultView;
    if (targetWindow) {
      await new Promise(resolve => targetWindow.requestAnimationFrame(resolve));
    }
    const scroll = () => {
      scrollPolicy.runExplicit(() => {
        const element = scrollElement.value;
        if (element && 'scrollHeight' in element) {
          element.scrollTo({ top: element.scrollHeight, behavior: 'auto' });
        } else {
          virtualizer.value.scrollToEnd({ behavior: 'auto' });
        }
      });
    };
    scroll();
  }

  function isFollowingTail() {
    if (!tailFollowReady.value) return false;
    const element = scrollElement.value;
    if (element && 'scrollHeight' in element) {
      return element.scrollHeight - element.clientHeight - element.scrollTop <= 50;
    }
    return virtualizer.value.isAtEnd(50);
  }

  function resetForInitialSnapshot() {
    tailFollowReady.value = false;
    scrollPolicy.runExplicit(() => {
      virtualizer.value.scrollToOffset(0, { behavior: 'auto' });
    });
  }

  function completeInitialSnapshot() {
    tailFollowReady.value = true;
  }

  async function waitForStableLayout({ maxFrames = 8, isCurrent = () => true } = {}) {
    const targetWindow = scrollElement.value?.ownerDocument?.defaultView;
    if (!targetWindow || items.value.length === 0) return true;
    for (let frame = 0; frame < maxFrames; frame++) {
      await new Promise(resolve => targetWindow.requestAnimationFrame(resolve));
      if (!isCurrent()) return false;
      const rows = [...virtualizer.value.elementsCache.values()]
        .filter(element => element.isConnected)
        .sort((left, right) => (
          Number(left.dataset.index) - Number(right.dataset.index)
        ))
        .map(element => element.getBoundingClientRect())
        .filter(rect => rect.height > 0);
      const overlaps = rows.some((rect, index) => (
        index > 0 && rect.top < rows[index - 1].bottom - 1
      ));
      if (rows.length > 0 && !overlaps) return true;
    }
    return false;
  }

  return {
    virtualRows,
    totalSize,
    measureElement,
    indexAtViewportEnd,
    scrollToIndex,
    scrollToEnd,
    isFollowingTail,
    resetForInitialSnapshot,
    completeInitialSnapshot,
    waitForStableLayout,
  };
}
