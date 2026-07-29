<script setup>
import { computed, ref } from 'vue';

defineOptions({ name: 'SessionImage' });

const props = defineProps({
  src: { type: String, required: true },
  alt: { type: String, default: '' },
  title: { type: String, default: '' },
});

const status = ref('loading');
const accessibleLabel = computed(() => props.alt || props.title || 'Session image');

function handleLoad() {
  status.value = 'loaded';
}

function handleError() {
  status.value = 'error';
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
      loading="lazy"
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
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.22);
}

img {
  display: block;
  inline-size: auto;
  max-inline-size: 100%;
  block-size: auto;
  max-block-size: min(70vh, 720px);
  object-fit: contain;
  color: rgba(255, 255, 255, 0.48);
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
  color: rgba(255, 255, 255, 0.48);
  font: 12px/1.5 ui-monospace, 'SF Mono', Menlo, monospace;
}

.image-label::before {
  content: '·';
  margin-inline-end: 6px;
}
</style>
