<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue'
import { useColorMode } from '@vueuse/core'
import { Loader2, RefreshCw, Check, CircleAlert, Copy, QrCode, ExternalLink, Ellipsis, X } from 'lucide-vue-next'
import Navbar from '@/components/Navbar.vue'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'

useColorMode({attribute:'class',modes:{dark:'dark',light:''}})
type Phase='syncing'|'success'|'error'
const phase=ref<Phase>('syncing')
const dismissed=ref(false)
const notification=ref(false)
const reduceMotion=ref(false)
const dialog=ref('')
const copied=ref('')
let timer:ReturnType<typeof setTimeout>|undefined
let copyTimer:ReturnType<typeof setTimeout>|undefined
const rows=[{id:'all',badge:'全部课表',name:'我的全部课表'},{id:'courses',badge:'课程',name:'我的课程'},{id:'exams',badge:'考试',name:'我的考试'}]
const messages={
  syncing:{title:'正在同步课表',description:'首次同步可能需要几分钟。'},
  success:{title:'课表已同步',description:'复制订阅链接，添加到你的日历。'},
  error:{title:'暂时无法同步',description:'订阅已保留，请稍后重试。'},
}
const message=computed(()=>messages[phase.value])
function changePhase(next:Phase){clearTimeout(timer);phase.value=next;dismissed.value=false}
function replay(){changePhase('syncing');timer=setTimeout(()=>changePhase('success'),2400)}
function demo(action:string){dialog.value=action}
async function copy(id:string){
  try{await navigator.clipboard.writeText('https://example.test/calendar/'+id+'.ics');copied.value=id;clearTimeout(copyTimer);copyTimer=setTimeout(()=>copied.value='',2000)}
  catch{demo('复制订阅链接')}
}
onBeforeUnmount(()=>{clearTimeout(timer);clearTimeout(copyTimer)})
</script>

<template>
  <div class="min-h-screen bg-background text-foreground antialiased" :class="{'reduce-motion':reduceMotion}">
    <Navbar />
    <main class="max-w-2xl mx-auto px-4 pt-24 pb-32">
      <section class="mb-6">
        <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div>
            <h1 class="text-base font-semibold">我的订阅 <span class="text-muted-foreground font-normal text-sm ml-1">(3/10)</span></h1>
            <p class="mt-1 inline-flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400"><span aria-hidden="true" class="h-1.5 w-1.5 rounded-full bg-emerald-500" />自动同步已开启</p>
            <div class="mt-2 flex items-center gap-2">
              <button type="button" role="switch" aria-label="课表变更通知" :aria-checked="notification" class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :class="notification?'bg-foreground':'bg-muted-foreground/35'" @click="notification=!notification"><span aria-hidden="true" class="block h-4 w-4 rounded-full bg-background shadow-sm transition-transform" :class="notification?'translate-x-4':'translate-x-0.5'" /></button>
              <span class="text-sm text-foreground">课表变更通知</span><span class="text-xs text-muted-foreground">有变化时发邮件</span>
            </div>
          </div>
          <div class="flex gap-2">
            <Button variant="outline" size="sm" :disabled="phase==='syncing'" @click="replay"><RefreshCw class="h-4 w-4 mr-1.5" />同步个人课表</Button>
            <Button variant="outline" size="sm" @click="demo('添加订阅')">添加订阅</Button>
          </div>
        </div>

        <div v-if="!dismissed" class="sync-notice mb-4 rounded-lg border border-border bg-muted/30 px-4 py-3" role="status" aria-live="polite">
          <div class="flex items-center gap-3 min-h-12">
            <div class="relative h-5 w-5 shrink-0" aria-hidden="true">
              <Transition name="status-icon"><Loader2 v-if="phase==='syncing'" class="absolute inset-0 h-5 w-5 animate-spin text-muted-foreground" /><Check v-else-if="phase==='success'" class="absolute inset-0 h-5 w-5 text-emerald-700 dark:text-emerald-400" /><CircleAlert v-else class="absolute inset-0 h-5 w-5 text-destructive" /></Transition>
            </div>
            <div class="min-w-0 flex-1"><p class="text-sm font-medium">{{ message.title }}</p><p class="text-xs text-muted-foreground mt-1">{{ message.description }}</p></div>
            <Button v-if="phase==='error'" variant="outline" size="sm" @click="replay">重试</Button>
            <button v-if="phase==='success'" class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" aria-label="关闭同步提示" @click="dismissed=true"><X class="h-4 w-4" /></button>
          </div>
        </div>

        <Card v-for="item in rows" :key="item.id" class="mb-4">
          <CardHeader>
            <CardTitle class="text-base flex items-center gap-2 flex-wrap"><Badge variant="secondary" class="text-xs">{{ item.badge }}</Badge>{{ item.name }}<Badge variant="outline" class="text-xs ml-auto shrink-0">个人</Badge></CardTitle>
            <div class="flex items-center gap-2 flex-wrap mt-1 min-h-4 text-xs text-muted-foreground">
              <span v-if="phase==='success'">刚刚同步</span><span v-else-if="phase==='error'" class="text-destructive">同步失败</span><span v-else>首次同步中…</span>
            </div>
          </CardHeader>
          <CardContent class="space-y-3">
            <div class="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" :disabled="phase==='syncing'" @click="replay"><RefreshCw class="h-4 w-4 mr-1.5" />{{ phase==='syncing'?'同步中':phase==='error'?'重试同步':'同步' }}</Button>
              <Button variant="outline" size="sm" :disabled="phase!=='success'" @click="copy(item.id)"><Check v-if="copied===item.id" class="h-4 w-4 mr-1.5" /><Copy v-else class="h-4 w-4 mr-1.5" />{{ copied===item.id?'已复制':'复制订阅链接' }}</Button>
              <Button variant="outline" size="icon" class="h-8 w-8" :disabled="phase!=='success'" aria-label="二维码" @click="demo('二维码')"><QrCode class="h-4 w-4" /></Button>
              <Button variant="outline" size="icon" class="h-8 w-8" :disabled="phase!=='success'" aria-label="网页预览" @click="demo('网页预览')"><ExternalLink class="h-4 w-4" /></Button>
              <Button variant="outline" size="icon" class="h-8 w-8" aria-label="更多" @click="demo('更多操作')"><Ellipsis class="h-4 w-4" /></Button>
            </div>
          </CardContent>
        </Card>
      </section>
    </main>
    <aside class="preview-tools fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-background px-4 py-3" aria-label="设计预览控制">
      <div class="max-w-2xl mx-auto flex flex-wrap items-center gap-3"><span class="text-xs text-muted-foreground">设计预览 · 演示数据</span><label class="sr-only" for="phase">同步状态</label><select id="phase" class="h-8 rounded-md border border-input bg-background px-2 text-xs" :value="phase" @change="changePhase(($event.target as HTMLSelectElement).value as Phase)"><option value="syncing">同步中</option><option value="success">同步完成</option><option value="error">同步失败</option></select><Button variant="outline" size="sm" @click="replay">重播</Button><label class="flex items-center gap-1.5 text-xs text-muted-foreground ml-auto"><input v-model="reduceMotion" type="checkbox" />减少动态</label></div>
    </aside>
    <Dialog :open="Boolean(dialog)" @update:open="value=>{if(!value)dialog=''}"><DialogContent><DialogHeader><DialogTitle>{{ dialog }}</DialogTitle><DialogDescription>此处沿用现有功能。预览使用演示数据，链接不可用于实际订阅。</DialogDescription></DialogHeader><Button @click="dialog=''">关闭</Button></DialogContent></Dialog>
  </div>
</template>

<style>
.status-icon-enter-active,.status-icon-leave-active{transition:opacity 180ms cubic-bezier(.19,1,.22,1)}
.status-icon-enter-from,.status-icon-leave-to{opacity:0}
.sync-notice{animation:notice-in 180ms cubic-bezier(.19,1,.22,1)}
@keyframes notice-in{from{opacity:0}to{opacity:1}}
.reduce-motion *{animation:none!important;transition:none!important}
@media(prefers-reduced-motion:reduce){.animate-spin,.sync-notice{animation:none}.status-icon-enter-active,.status-icon-leave-active{transition:none}}
@media(max-width:600px){header>div>div{flex-wrap:wrap;gap:6px}header nav{gap:12px!important;flex-wrap:wrap}header nav a{font-size:12px!important}main{padding-top:136px!important}.preview-tools{padding-bottom:max(12px,env(safe-area-inset-bottom))}}
</style>
