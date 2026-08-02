<script setup>
import { computed, ref, watch } from 'vue';
import { SESSION_IMAGE_SETTLED_EVENT } from '../session-image-contract.js';

defineOptions({ name: 'SessionImage' });

const props = defineProps({
  // Absent when the Markdown renderer refused the source. The element still
  // renders, in its error state, so a blocked source and a source that fails
  // to load are one piece of UI rather than two.
  src: { type: String, default: '' },
  alt: { type: String, default: '' },
  title: { type: String, default: '' },
});

const status = ref(props.src ? 'loading' : 'error');
const accessibleLabel = computed(() => props.alt || props.title || 'Session image');

watch(() => props.src, source => {
  status.value = source ? 'loading' : 'error';
});

// Announce synchronously, before the resize observation this growth triggers,
// so the timeline already knows the row is about to change size for a reason
// the reader did not cause.
function announceSettled(event) {
  event.target?.dispatchEvent(new CustomEvent(SESSION_IMAGE_SETTLED_EVENT, {
    bubbles: true,
    composed: true,
  }));
}

function handleLoad(event) {
  status.value = 'loaded';
  announceSettled(event);
}

function handleError(event) {
  status.value = 'error';
  announceSettled(event);
}
</script>

<template>
  <figure
    class="session-image"
    :class="`is-${status}`"
    :aria-busy="status === 'loading' ? 'true' : undefined"
  >
    <img
      v-if="status !== 'error'"
      :src="src"
      :alt="alt"
      :title="title || undefined"
      decoding="async"
      @load="handleLoad"
      @error="handleError"
    >
    <figcaption v-else role="status">
      <span>Image unavailable</span>
      <span v-if="accessibleLabel" class="image-label">{{ accessibleLabel }}</span>
    </figcaption>
  </figure>
</template>

<style>
/* Custom properties cross the shadow boundary, so the app's tokens are the
   single source of truth for these colours. --session-image-max-block lets a
   host context (a compact Markdown block, say) cap the image lower than the
   session timeline does. */
:host {
  display: block;
  max-inline-size: 100%;
  min-inline-size: 0;
  margin: 0.7em 0;
  contain: inline-size;
}

.session-image {
  max-inline-size: 100%;
  min-inline-size: 0;
  margin: 0;
  overflow: clip;
  border: 1px solid var(--hairline-strong);
  border-radius: 6px;
  background: var(--session-image-backdrop, rgba(0, 0, 0, 0.22));
}

img {
  display: block;
  inline-size: auto;
  max-inline-size: 100%;
  block-size: auto;
  max-block-size: var(--session-image-max-block, min(70vh, 720px));
  object-fit: contain;
  color: var(--muted);
}

.is-loading {
  min-block-size: 48px;
}

figcaption {
  display: flex;
  min-block-size: 48px;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  color: var(--muted);
  font: var(--text-sm, 12px)/1.5 var(--font-mono);
}

.image-label::before {
  content: '·';
  margin-inline-end: 6px;
}
</style>
