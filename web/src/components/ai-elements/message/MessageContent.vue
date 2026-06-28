<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { cn } from '@/lib/utils';

const props = defineProps<{ class?: HTMLAttributes['class'] }>();
</script>

<template>
  <!-- .bubble + the parent .is-user/.is-assistant class drive the colours (style.css). -->
  <div :class="cn('bubble flex w-fit flex-col gap-2 overflow-hidden text-sm', props.class)" v-bind="$attrs">
    <slot />
  </div>
</template>
