<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRoute } from 'vue-router';
import { copyText } from '@/lib/clipboard';

// Hover-revealed actions for a transcript message: copy the text, a real link
// to the message, and copy its "sessionId:line" locator. Rendered as an overlay
// so it never changes the bubble's size, padding, or the page layout.
const props = defineProps<{
  sessionId: string;
  filePath: string;
  lineNumbers: number[];
  text: string;
}>();

const route = useRoute();

// The line to link/copy — mirror how search results locate a message (first line).
const line = computed(() => props.lineNumbers[0] ?? 0);

// The exact "sessionId:line" locator the id button copies.
const idString = computed(() => `${props.sessionId}:${line.value}`);

// A real router location so the anchor gets a genuine href: left-click navigates
// (highlights the message), middle/cmd-click opens a new tab, right-click "copy
// link" works. Carry q along so the sidebar keeps its results.
const linkTo = computed(() => ({
  name: 'session',
  params: { id: props.sessionId },
  query: { q: route.query.q, file: props.filePath, line: String(line.value) },
}));

const copied = ref<'' | 'text' | 'id'>('');
let timer: ReturnType<typeof setTimeout> | undefined;
function flash(which: 'text' | 'id'): void {
  copied.value = which;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => (copied.value = ''), 1000);
}

async function onCopyText(): Promise<void> {
  if (await copyText(props.text)) flash('text');
}
async function onCopyId(): Promise<void> {
  if (await copyText(idString.value)) flash('id');
}
</script>

<template>
  <div class="msg-actions">
   <div class="msg-actions-bar">
    <!-- Copy message text -->
    <button
      type="button"
      class="msg-action"
      :class="{ 'is-copied': copied === 'text' }"
      :title="copied === 'text' ? 'Copied' : 'Copy text'"
      aria-label="Copy message text"
      @click="onCopyText"
    >
      <svg v-if="copied === 'text'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 6L9 17l-5-5" />
      </svg>
      <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
    </button>

    <!-- Link to this message -->
    <RouterLink class="msg-action" :to="linkTo" title="Link to this message" aria-label="Link to this message">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
    </RouterLink>

    <!-- Copy the "sessionId:line" locator -->
    <button
      type="button"
      class="msg-action"
      :class="{ 'is-copied': copied === 'id' }"
      :title="copied === 'id' ? 'Copied' : idString"
      aria-label="Copy message id"
      @click="onCopyId"
    >
      <svg v-if="copied === 'id'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 6L9 17l-5-5" />
      </svg>
      <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="4" y1="9" x2="20" y2="9" />
        <line x1="4" y1="15" x2="20" y2="15" />
        <line x1="10" y1="3" x2="8" y2="21" />
        <line x1="16" y1="3" x2="14" y2="21" />
      </svg>
    </button>
   </div>
  </div>
</template>
