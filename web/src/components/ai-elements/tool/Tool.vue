<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { Collapsible } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

const props = defineProps<{ defaultOpen?: boolean; class?: HTMLAttributes['class'] }>();
</script>

<template>
  <Collapsible
    :default-open="props.defaultOpen ?? false"
    :class="cn('tool-block group w-full rounded-md border', props.class)"
    v-bind="$attrs"
  >
    <slot />
  </Collapsible>
</template>
