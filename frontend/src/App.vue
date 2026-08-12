<script setup lang="ts">
import { TooltipProvider } from '@/components/ui/tooltip';
</script>

<template>
  <TooltipProvider :delay-duration="250">
    <RouterView />
  </TooltipProvider>
</template>
