<script setup lang="ts">
import { ProgressRoot, ProgressIndicator } from 'reka-ui';
import type { ProgressRootProps } from 'reka-ui';
import { cn } from '@/lib/utils';

const props = withDefaults(
  defineProps<ProgressRootProps & { class?: string }>(),
  { modelValue: 0 },
);
</script>

<template>
  <ProgressRoot
    :class="cn('relative h-1.5 w-full overflow-hidden rounded-full bg-secondary', props.class)"
    :model-value="props.modelValue"
    :max="props.max ?? 100"
  >
    <ProgressIndicator
      class="h-full w-full flex-1 bg-primary transition-all duration-500 ease-in-out"
      :style="{ transform: `translateX(-${100 - (props.modelValue ?? 0)}%)` }"
    />
  </ProgressRoot>
</template>
