<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

const props = defineProps<{ name: string; isError?: boolean; class?: HTMLAttributes['class'] }>();
</script>

<template>
  <CollapsibleTrigger :class="cn('tool-header flex w-full items-center justify-between gap-4 p-3', props.class)" v-bind="$attrs">
    <span class="flex items-center gap-2">
      <!-- wrench -->
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.6">
        <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2-2 2.5-2.5z" />
      </svg>
      <span class="tool-name font-medium text-sm">{{ props.name || 'tool' }}</span>
      <span class="tool-status" :class="props.isError ? 'tool-status-error' : 'tool-status-ok'">
        {{ props.isError ? 'Error' : 'Completed' }}
      </span>
    </span>
    <!-- chevron (rotates when open via CSS in style.css) -->
    <svg class="tool-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.6">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  </CollapsibleTrigger>
</template>
