<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { computed } from 'vue';
import { CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

const props = defineProps<{
  trigger?: string;
  tokensBefore?: number;
  class?: HTMLAttributes['class'];
}>();

// A muted one-line detail: the trigger and/or "~N tokens", when known.
const detail = computed(() => {
  const parts: string[] = [];
  if (props.trigger) parts.push(props.trigger);
  if (props.tokensBefore !== undefined) {
    parts.push('~' + props.tokensBefore.toLocaleString() + ' tokens');
  }
  return parts.join(' · ');
});
</script>

<template>
  <CollapsibleTrigger :class="cn('tool-header flex w-full items-center justify-between gap-4 p-3', props.class)" v-bind="$attrs">
    <span class="flex items-center gap-2">
      <!-- archive / compaction -->
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.6">
        <rect x="2" y="3" width="20" height="5" rx="1" />
        <path d="M4 8v11a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V8" />
        <line x1="9" y1="12" x2="15" y2="12" />
      </svg>
      <span class="font-medium text-sm">Compaction</span>
      <span v-if="detail" class="compaction-detail">{{ detail }}</span>
    </span>
    <!-- chevron (rotates when open via CSS in style.css) -->
    <svg class="tool-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.6">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  </CollapsibleTrigger>
</template>
