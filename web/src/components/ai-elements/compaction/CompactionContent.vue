<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { CollapsibleContent } from '@/components/ui/collapsible';
import { renderMarkdown } from '@/lib/markdown';
import { cn } from '@/lib/utils';

const props = defineProps<{ summary: string; class?: HTMLAttributes['class'] }>();
</script>

<template>
  <CollapsibleContent :class="cn('tool-content', props.class)" v-bind="$attrs">
    <div class="tool-section">
      <div v-if="props.summary" class="md-body" v-html="renderMarkdown(props.summary)"></div>
      <div v-else class="compaction-empty">No summary recorded</div>
    </div>
  </CollapsibleContent>
</template>
