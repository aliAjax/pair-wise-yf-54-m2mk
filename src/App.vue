<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useOnline } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { api } from './services/api';
import { useExhibitionStore, type Exhibit, type ReleaseOrder } from './stores/exhibition';

const store = useExhibitionStore();
const online = useOnline();
const tab = ref<'checkin' | 'environment' | 'discrepancy' | 'transfer' | 'cabinet'>('checkin');
const dialog = ref(false);
const selected = ref<Exhibit | null>(null);
const schema = toTypedSchema(z.object({ code: z.string().min(2), name: z.string().min(2), lender: z.string().min(2), hall: z.string().min(2) }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema });
const [code] = defineField('code');
const [name] = defineField('name');
const [lender] = defineField('lender');
const [hall] = defineField('hall');
const apiLabel = computed(() => String(api.defaults.baseURL));

const submit = handleSubmit((values) => { store.addExhibit(values); dialog.value = false; resetForm(); });
function stageLabel(stage: Exhibit['stage']) { return { arrival: '到场点交', install: '布展核验', return: '闭展归还' }[stage]; }

// ---- 环境读数过期扫描：过期后结论与签字立即失效 ----
let sweepTimer: ReturnType<typeof setInterval> | undefined;
onMounted(() => { store.sweepExpired(); sweepTimer = setInterval(() => store.sweepExpired(), 20_000); });
onUnmounted(() => { if (sweepTimer) clearInterval(sweepTimer); });

function readingInfo(item: Exhibit) {
  const expired = store.isEnvExpired(item);
  const remainMs = Math.max(0, item.environment.validForMs - (Date.now() - item.environment.measuredAt));
  const remainMin = Math.ceil(remainMs / 60000);
  return {
    expired,
    text: expired ? '已过期' : `有效 ${remainMin} 分钟`,
    time: new Date(item.environment.measuredAt).toLocaleTimeString('zh-CN', { hour12: false })
  };
}

// ---- 转柜放行单 ----
const orderForm = ref<{ exhibitIds: string[]; toCabinetId: string }>({ exhibitIds: [], toCabinetId: '' });
const orderMsg = ref('');
function submitTransfer() {
  const res = store.createOrder(orderForm.value.exhibitIds, orderForm.value.toCabinetId);
  if (!res.ok || !res.order) { orderMsg.value = res.reason ?? '无法创建放行单'; return; }
  store.submitOrder(res.order.id);
  const o = store.orders.find((x) => x.id === res.order!.id);
  if (o?.status === 'completed') orderMsg.value = '全部展品已到柜';
  else if (o) orderMsg.value = `部分到柜：${o.failedIds.length} 件未到柜，可只重试未到柜展品`;
  orderForm.value = { exhibitIds: [], toCabinetId: '' };
}
function orderStatusColor(status: ReleaseOrder['status']) {
  return { pending: 'grey', completed: 'green', partial: 'orange', failed: 'red', archived: 'blue-grey' }[status];
}
function orderStatusLabel(status: ReleaseOrder['status']) {
  return { pending: '待提交', completed: '已完成', partial: '部分到柜', failed: '转柜失败', archived: '历史批次' }[status];
}
function cabinetName(id: string) { return store.cabinets.find((c) => c.id === id)?.name ?? '—'; }
function exhibitCode(id: string) { return store.exhibits.find((e) => e.id === id)?.code ?? id; }
function exhibitName(id: string) { return store.exhibits.find((e) => e.id === id)?.name ?? ''; }
</script>

<template>
  <v-app>
    <v-app-bar color="deep-purple-darken-3" flat>
      <v-app-bar-title>{{ $t('title') }}</v-app-bar-title>
      <v-chip class="mr-3" :color="online ? 'green' : 'orange'" theme="dark">{{ online ? '在线' : '离线暂存' }}</v-chip>
      <v-btn prepend-icon="mdi-plus" @click="dialog = true">登记展品</v-btn>
    </v-app-bar>
    <v-main class="bg-grey-lighten-4">
      <v-container fluid class="pa-6">
        <v-alert v-if="!online || store.queued" color="orange-lighten-4" icon="mdi-cloud-off-outline" class="mb-5">
          网络不可用时核验不会丢失：当前有 {{ store.queued }} 条变更在本地队列。接口地址 {{ apiLabel }}
          <template #append><v-btn v-if="online" variant="text" @click="store.syncQueue">确认同步</v-btn></template>
        </v-alert>
        <v-alert v-if="store.expiredCount" color="red-lighten-4" icon="mdi-alert-circle-outline" class="mb-5">
          有 {{ store.expiredCount }} 件展品的环境读数已过期，依赖读数的条件结论与签字已失效并退回复核，请刷新读数后重新核验。
        </v-alert>

        <v-row class="mb-5">
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">待到场点交</div><div class="metric">{{ store.stageCounts.arrival }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">布展中</div><div class="metric">{{ store.stageCounts.install }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">未解决差异</div><div class="metric warn">{{ store.unresolved }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">读数过期</div><div class="metric warn">{{ store.expiredCount }}</div></v-card-text></v-card></v-col>
        </v-row>

        <v-card>
          <v-tabs v-model="tab" color="deep-purple">
            <v-tab value="checkin">{{ $t('checkIn') }}</v-tab>
            <v-tab value="environment">{{ $t('environment') }}</v-tab>
            <v-tab value="discrepancy">{{ $t('discrepancies') }}</v-tab>
            <v-tab value="transfer">转柜放行</v-tab>
            <v-tab value="cabinet">柜位容量</v-tab>
          </v-tabs>
          <v-window v-model="tab">
            <v-window-item value="checkin">
              <v-virtual-scroll :items="store.exhibits" height="520" item-height="112">
                <template #default="{ item }">
                  <v-list-item :key="item.id" class="exhibit-row" @click="selected = item">
                    <template #prepend><v-avatar color="deep-purple-lighten-4">{{ item.code.slice(1) }}</v-avatar></template>
                    <v-list-item-title>{{ item.name }} · {{ item.code }}</v-list-item-title>
                    <v-list-item-subtitle>
                      {{ item.lender }} · {{ item.hall }} · {{ stageLabel(item.stage) }}
                      <span class="batch-tag">批次 {{ item.batchId }}</span>
                    </v-list-item-subtitle>
                    <template #append>
                      <v-chip size="small" :color="item.status === 'issue' ? 'red' : item.status === 'passed' ? 'green' : 'grey'">{{ item.status }}</v-chip>
                    </template>
                  </v-list-item>
                </template>
              </v-virtual-scroll>
            </v-window-item>

            <v-window-item value="environment">
              <v-table>
                <thead><tr><th>展品</th><th>温度</th><th>湿度</th><th>照度</th><th>读数时间</th><th>有效期</th><th>操作</th></tr></thead>
                <tbody><tr v-for="item in store.exhibits" :key="item.id">
                  <td>{{ item.code }}</td>
                  <td>{{ item.environment.temperature }}℃</td>
                  <td>{{ item.environment.humidity }}%</td>
                  <td>{{ item.environment.light }} lux</td>
                  <td>{{ readingInfo(item).time }}</td>
                  <td><v-chip size="small" :color="readingInfo(item).expired ? 'red' : 'green'">{{ readingInfo(item).text }}</v-chip></td>
                  <td>
                    <v-btn size="small" color="blue-grey" variant="text" @click="store.refreshEnvironment(item.id)">刷新读数</v-btn>
                    <v-btn size="small" color="green" variant="text" :disabled="readingInfo(item).expired" @click="store.setCondition(item.id, 'passed')">通过</v-btn>
                    <v-btn size="small" color="red" variant="text" :disabled="readingInfo(item).expired" @click="store.setCondition(item.id, 'issue')">异常</v-btn>
                  </td>
                </tr></tbody>
              </v-table>
            </v-window-item>

            <v-window-item value="discrepancy">
              <v-list><v-list-item v-for="item in store.discrepancies" :key="item.id"><v-list-item-title>{{ item.title }}</v-list-item-title><v-list-item-subtitle>展品 {{ item.exhibitId }} · {{ item.severity === 'major' ? '重大差异' : '轻微差异' }}</v-list-item-subtitle><template #append><v-btn :disabled="item.resolved" color="green" @click="store.resolveDiscrepancy(item.id)">{{ item.resolved ? '已解决' : '确认解决' }}</v-btn></template></v-list-item></v-list>
            </v-window-item>

            <v-window-item value="transfer">
              <v-card-text>
                <v-alert type="info" variant="tonal" class="mb-4">
                  同一批放行单带多件展品一起过柜；未解决差异或读数过期会挡住该批展品。两个保管员提交同一柜位时，后来的一方按剩余容量重排，放不下的展品记为未到柜，可只重试这些展品并保留原批次。
                </v-alert>
                <v-row>
                  <v-col cols="12" md="5">
                    <v-select v-model="orderForm.exhibitIds" :items="store.exhibits" item-title="name" item-value="id" label="选择展品（可多选）" multiple chips variant="outlined" density="compact">
                      <template #item="{ item: ex, props }">
                        <v-list-item v-bind="props" :title="`${ex.raw.code} · ${ex.raw.name}`" :subtitle="`${ex.raw.hall} · 批次 ${ex.raw.batchId}`" />
                      </template>
                    </v-select>
                  </v-col>
                  <v-col cols="12" md="4">
                    <v-select v-model="orderForm.toCabinetId" :items="store.cabinetRows" item-title="name" item-value="id" label="目标柜位" variant="outlined" density="compact" />
                  </v-col>
                  <v-col cols="12" md="3">
                    <v-btn color="deep-purple" block @click="submitTransfer">提交放行单</v-btn>
                  </v-col>
                </v-row>
                <v-alert v-if="orderMsg" :type="orderMsg.includes('无法') || orderMsg.includes('挡住') || orderMsg.includes('过期') ? 'error' : 'success'" variant="tonal" class="mt-2">{{ orderMsg }}</v-alert>
              </v-card-text>
              <v-divider />
              <v-list>
                <v-list-item v-for="order in store.sortedOrders" :key="order.id" class="order-row">
                  <v-list-item-title>
                    {{ order.code }}
                    <v-chip size="small" class="ml-2" :color="orderStatusColor(order.status)">{{ orderStatusLabel(order.status) }}</v-chip>
                  </v-list-item-title>
                  <v-list-item-subtitle>
                    目标柜位：{{ order.toCabinetId ? cabinetName(order.toCabinetId) : '—' }} ·
                    已到柜 {{ order.arrivals.length }}/{{ order.exhibitIds.length }}
                    <span v-if="order.submittedAt"> · 提交于 {{ new Date(order.submittedAt).toLocaleTimeString('zh-CN', { hour12: false }) }}</span>
                    <span v-if="order.note"> · {{ order.note }}</span>
                  </v-list-item-subtitle>
                  <v-list-item-subtitle v-if="order.arrivals.length">
                    到柜：<v-chip v-for="a in order.arrivals" :key="a.exhibitId" size="small" class="mr-1" color="green-lighten-4">{{ exhibitCode(a.exhibitId) }} → {{ cabinetName(a.cabinetId) }}</v-chip>
                  </v-list-item-subtitle>
                  <v-list-item-subtitle v-if="order.failedIds.length">
                    未到柜：<v-chip v-for="id in order.failedIds" :key="id" size="small" class="mr-1" color="red-lighten-4">{{ exhibitCode(id) }} · {{ exhibitName(id) }}</v-chip>
                    <v-btn size="small" color="orange" variant="tonal" class="ml-2" @click="store.retryOrder(order.id)">只重试未到柜展品</v-btn>
                  </v-list-item-subtitle>
                </v-list-item>
              </v-list>
            </v-window-item>

            <v-window-item value="cabinet">
              <v-card-text>
                <v-row>
                  <v-col v-for="c in store.cabinetRows" :key="c.id" cols="12" md="4">
                    <v-card variant="outlined">
                      <v-card-text>
                        <div class="d-flex justify-space-between">
                          <b>{{ c.name }}</b>
                          <span>{{ c.occupied }}/{{ c.capacity }} · 剩余 {{ c.remaining }}</span>
                        </div>
                        <v-progress-linear class="mt-3" :model-value="c.occupied" :max="c.capacity" color="deep-purple" height="10" rounded />
                      </v-card-text>
                    </v-card>
                  </v-col>
                </v-row>
              </v-card-text>
            </v-window-item>
          </v-window>
        </v-card>

        <v-dialog v-model="dialog" max-width="560">
          <v-card title="登记新展品">
            <v-card-text><v-form @submit.prevent="submit"><v-text-field v-model="code" label="展品编号" :error-messages="errors.code" /><v-text-field v-model="name" label="展品名称" :error-messages="errors.name" /><v-text-field v-model="lender" label="借展方" :error-messages="errors.lender" /><v-text-field v-model="hall" label="展厅/柜位" :error-messages="errors.hall" /><v-btn type="submit" color="deep-purple" block>写入点交队列</v-btn></v-form></v-card-text>
          </v-card>
        </v-dialog>

        <v-dialog :model-value="Boolean(selected)" max-width="680" @update:model-value="selected = null">
          <v-card v-if="selected" :title="`${selected.code} · ${selected.name}`">
            <v-card-text>
              <v-alert v-if="store.isEnvExpired(selected)" type="error" variant="tonal" class="mb-3">环境读数已过期，条件结论与签字已失效并退回复核，请先到「环境条件」刷新读数。</v-alert>
              <v-timeline side="end" density="compact">
                <v-timeline-item dot-color="green"><b>保管员点收</b><p>核对包装、封条和附件清单。</p><v-btn size="small" :disabled="selected.signed.includes('保管员') || store.isEnvExpired(selected)" @click="store.sign(selected.id, '保管员')">{{ selected.signed.includes('保管员') ? '已签字' : '保管员签字' }}</v-btn></v-timeline-item>
                <v-timeline-item dot-color="orange"><b>借展方确认</b><p>确认差异项及后续责任。</p><v-btn size="small" :disabled="selected.signed.includes('借展方') || store.isEnvExpired(selected)" @click="store.sign(selected.id, '借展方')">{{ selected.signed.includes('借展方') ? '已签字' : '借展方签字' }}</v-btn></v-timeline-item>
                <v-timeline-item dot-color="purple"><b>推进阶段</b><p>存在未解决差异、缺少借展方签字或读数过期时不能推进。</p><v-btn size="small" color="deep-purple" @click="store.advance(selected.id)">推进到下一阶段</v-btn></v-timeline-item>
              </v-timeline>
            </v-card-text>
          </v-card>
        </v-dialog>
      </v-container>
    </v-main>
  </v-app>
</template>

<style>
.metric-label { color: #6b7280; font-size: 13px; }
.metric { font-size: 31px; font-weight: 750; color: #4c1d95; }
.metric.warn { color: #b91c1c; }
.exhibit-row { border-bottom: 1px solid #eee; cursor: pointer; }
.batch-tag { margin-left: 6px; color: #6d28d9; font-size: 12px; }
.order-row { border-bottom: 1px solid #eee; }
</style>
