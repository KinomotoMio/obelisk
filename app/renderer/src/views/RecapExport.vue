<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import CoverCard from '../components/recap/CoverCard.vue';
import PathCard from '../components/recap/PathCard.vue';
import VibeCard from '../components/recap/VibeCard.vue';
import WorkflowCard from '../components/recap/WorkflowCard.vue';
import ClosingCard from '../components/recap/ClosingCard.vue';
import { PALETTES, ARCH_KEYS } from '../components/recap/archetypes.js';
import recapJson from '../mock/recap-2026-W24.json';

const route = useRoute();
const cardIdx = computed(() => parseInt(route.query.card) || 0);
const archKey = computed(() => route.query.arch || recapJson.persona.archetype);
const palette = computed(() => PALETTES[archKey.value] || PALETTES.architect);

const cover = recapJson.cards[0];
const path = recapJson.cards[1];
const vibe = recapJson.cards[2];
const workflow = recapJson.cards[3];
const closing = recapJson.cards[4];

const cssVars = computed(() => ({
  '--tc': palette.value.tc,
  '--tc-2': palette.value.tc2,
  '--tg': palette.value.glow,
  '--tg-mid': palette.value.mid,
  '--tg-soft': palette.value.soft,
  '--tg-edge': palette.value.soft,
}));
</script>

<template>
  <div class="export-wrap" :style="cssVars">
    <CoverCard v-if="cardIdx === 0"
      :arch-key="archKey" :badge="cover.badge" :title="cover.title"
      :subtitle="cover.subtitle" :activity="cover.activity" :footer="cover.footer"
      :idx="1" :total="5"
    />
    <PathCard v-else-if="cardIdx === 1"
      :title="path.title" :items="path.items"
      :idx="2" :total="5"
    />
    <VibeCard v-else-if="cardIdx === 2"
      :title="vibe.title" :observations="vibe.observations"
      :meter="vibe.meter" :quote="vibe.quote"
      :idx="3" :total="5"
    />
    <WorkflowCard v-else-if="cardIdx === 3"
      :title="workflow.title" :summary="workflow.summary"
      :stats="workflow.stats" :items="workflow.items" :verdict="workflow.verdict"
      :idx="4" :total="5"
    />
    <ClosingCard v-else-if="cardIdx === 4"
      :headline="closing.headline" :stats="closing.stats"
      :most-said-phrase="closing.most_said_phrase" :signoff="closing.signoff"
      :idx="5" :total="5"
    />
  </div>
</template>

<style scoped>
.export-wrap {
  --bg: #0a0b14;
  --bg-2: #11131f;
  --surface: rgba(255,255,255,0.03);
  --surface-strong: rgba(255,255,255,0.06);
  --fg: rgba(255,255,255,0.94);
  --fg-2: rgba(255,255,255,0.74);
  --fg-3: rgba(255,255,255,0.55);
  --muted: rgba(255,255,255,0.48);
  --muted-2: rgba(255,255,255,0.28);
  --muted-3: rgba(255,255,255,0.16);
  --hairline: rgba(255,255,255,0.05);
  --hairline-strong: rgba(255,255,255,0.10);
  --hairline-vivid: rgba(255,255,255,0.16);
  --font-sans: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', system-ui, sans-serif;
  --font-mono: ui-monospace, 'JetBrains Mono', 'IBM Plex Mono', 'SF Mono', Menlo, monospace;
  --font-serif: 'Iowan Old Style', 'Charter', 'Source Serif Pro', Georgia, serif;
  --transition: 220ms cubic-bezier(0.22, 1, 0.36, 1);
  --transition-fast: 120ms ease;
  --theme-ease: 380ms cubic-bezier(0.22, 1, 0.36, 1);

  width: 540px;
  height: 675px;
  position: relative;
  background: var(--bg);
  color: var(--fg);
  font: 13px/1.45 var(--font-sans);
  -webkit-font-smoothing: antialiased;
  overflow: hidden;
}
</style>
