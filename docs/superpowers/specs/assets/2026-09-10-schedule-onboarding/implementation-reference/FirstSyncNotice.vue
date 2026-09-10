<script setup lang="ts">
import { Loader2, Check, CircleAlert, X } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
export type FirstSyncPhase = 'preparing' | 'syncing' | 'success' | 'error'
const props = withDefaults(defineProps<{
  phase: FirstSyncPhase
  preparationFailed?: boolean
  errorMessage?: string
  retryDisabled?: boolean
  retryHint?: string
}>(), {preparationFailed:false, errorMessage:'', retryDisabled:false, retryHint:''})
defineEmits<{retry:[]; dismiss:[]}>()
const titles = {preparing:'正在准备订阅',syncing:'正在同步课表',success:'课表已同步',error:'暂时无法同步'}
const descriptions = {preparing:'',syncing:'首次同步可能需要几分钟。',success:'复制订阅链接，添加到你的日历。',error:'订阅已保留，请稍后重试。'}
</script>
<template>
  <div class="sync-notice mb-4 rounded-lg border border-border bg-muted/30 px-4 py-3" role="status" aria-live="polite">
    <div class="flex items-center gap-3 min-h-12">
      <div class="relative h-5 w-5 shrink-0" aria-hidden="true">
        <Transition name="status-icon">
          <Loader2 v-if="phase==='syncing'||phase==='preparing'" class="absolute inset-0 h-5 w-5 animate-spin text-muted-foreground" />
          <Check v-else-if="phase==='success'" class="absolute inset-0 h-5 w-5 text-emerald-700 dark:text-emerald-400" />
          <CircleAlert v-else class="absolute inset-0 h-5 w-5 text-destructive" />
        </Transition>
      </div>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">{{ preparationFailed ? '订阅准备未完成' : titles[phase] }}</p>
        <p v-if="phase!=='preparing'" class="text-xs text-muted-foreground mt-1">{{ errorMessage || (preparationFailed ? '请重试。' : descriptions[phase]) }}</p>
      </div>
      <Button v-if="phase==='error'" variant="outline" size="sm" :disabled="props.retryDisabled" :title="props.retryHint" @click="$emit('retry')">重试</Button>
      <button v-if="phase==='success'" class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" aria-label="关闭同步提示" @click="$emit('dismiss')"><X class="h-4 w-4" /></button>
    </div>
  </div>
</template>
<style scoped>
.status-icon-enter-active,.status-icon-leave-active{transition:opacity 180ms cubic-bezier(.19,1,.22,1)}
.status-icon-enter-from,.status-icon-leave-to{opacity:0}
.sync-notice{animation:notice-in 180ms cubic-bezier(.19,1,.22,1)}
@keyframes notice-in{from{opacity:0}to{opacity:1}}
@media(prefers-reduced-motion:reduce){.animate-spin,.sync-notice{animation:none}.status-icon-enter-active,.status-icon-leave-active{transition:none}}
</style>
