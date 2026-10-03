<script setup lang="ts">
import { computed, ref } from 'vue';
import { useIntervalFn, useOnline } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { api } from './services/api';
import { useExhibitionStore, type Exhibit, type TransferBatch } from './stores/exhibition';

const store = useExhibitionStore();
const online = useOnline();
const tab = ref<'checkin' | 'environment' | 'discrepancy' | 'transfer'>('checkin');
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

// 转柜放行
const now = ref(Date.now());
useIntervalFn(() => { now.value = Date.now(); store.checkEnvExpiry(); }, 1000);
const batchDialog = ref(false);
const batchExhibits = ref<string[]>([]);
const batchHall = ref('A2 温湿展柜');
const spilledNotice = ref<string[]>([]);
const envDialog = ref(false);
const envTarget = ref<string | null>(null);
const envForm = ref({ temperature: 20, humidity: 50, light: 150 });
const halls = computed(() => Object.keys(store.cabinets));
const remainingCapacity = computed(() => Math.max((store.cabinets[batchHall.value]?.capacity ?? 0) - store.cabinetOccupancy(batchHall.value), 0));

function exhibitCode(id: string) { return store.exhibitById(id)?.code ?? id; }
function submitBatch() {
  if (!batchExhibits.value.length) return;
  const { spilled } = store.createBatch(batchExhibits.value, batchHall.value, '保管员');
  spilledNotice.value = spilled.map(exhibitCode);
  batchDialog.value = false;
  batchExhibits.value = [];
}
function openEnv(batchId: string) { envTarget.value = batchId; envDialog.value = true; }
function saveEnv() { if (envTarget.value) store.recordEnv(envTarget.value, { ...envForm.value }); envDialog.value = false; }
function countdown(batch: TransferBatch) {
  if (!batch.env) return '未录入';
  const left = batch.env.expiresAt - now.value;
  if (left <= 0) return '已过期';
  const minutes = Math.floor(left / 60000);
  const seconds = Math.floor((left % 60000) / 1000);
  return `剩余 ${minutes}分${String(seconds).padStart(2, '0')}秒`;
}
function batchStatusLabel(status: TransferBatch['status']) { return { pending: '复核中', 'in-transit': '转柜中', failed: '转柜失败', completed: '已到柜' }[status]; }
function batchStatusColor(status: TransferBatch['status']) { return { pending: 'orange', 'in-transit': 'blue', failed: 'red', completed: 'green' }[status]; }
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

        <v-row class="mb-5">
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">待到场点交</div><div class="metric">{{ store.stageCounts.arrival }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">布展中</div><div class="metric">{{ store.stageCounts.install }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">未解决差异</div><div class="metric warn">{{ store.unresolved }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">本地待同步</div><div class="metric">{{ store.queued }}</div></v-card-text></v-card></v-col>
        </v-row>

        <v-card>
          <v-tabs v-model="tab" color="deep-purple">
            <v-tab value="checkin">{{ $t('checkIn') }}</v-tab><v-tab value="environment">{{ $t('environment') }}</v-tab><v-tab value="discrepancy">{{ $t('discrepancies') }}</v-tab><v-tab value="transfer">{{ $t('transfer') }}</v-tab>
          </v-tabs>
          <v-window v-model="tab">
            <v-window-item value="checkin">
              <v-virtual-scroll :items="store.exhibits" height="520" item-height="112">
                <template #default="{ item }">
                  <v-list-item :key="item.id" class="exhibit-row" @click="selected = item">
                    <template #prepend><v-avatar color="deep-purple-lighten-4">{{ item.code.slice(1) }}</v-avatar></template>
                    <v-list-item-title>{{ item.name }} · {{ item.code }}</v-list-item-title>
                    <v-list-item-subtitle>{{ item.lender }} · {{ item.hall }} · {{ stageLabel(item.stage) }}</v-list-item-subtitle>
                    <template #append>
                      <v-chip size="small" :color="item.status === 'issue' ? 'red' : item.status === 'passed' ? 'green' : 'grey'">{{ item.status }}</v-chip>
                    </template>
                  </v-list-item>
                </template>
              </v-virtual-scroll>
            </v-window-item>
            <v-window-item value="environment">
              <v-table>
                <thead><tr><th>展品</th><th>温度</th><th>湿度</th><th>照度</th><th>条件</th></tr></thead>
                <tbody><tr v-for="item in store.exhibits" :key="item.id"><td>{{ item.code }}</td><td>{{ item.environment.temperature }}℃</td><td>{{ item.environment.humidity }}%</td><td>{{ item.environment.light }} lux</td><td><v-btn size="small" color="green" variant="text" @click="store.setCondition(item.id, 'passed')">通过</v-btn><v-btn size="small" color="red" variant="text" @click="store.setCondition(item.id, 'issue')">异常</v-btn></td></tr></tbody>
              </v-table>
            </v-window-item>
            <v-window-item value="discrepancy">
              <v-list><v-list-item v-for="item in store.discrepancies" :key="item.id"><v-list-item-title>{{ item.title }}</v-list-item-title><v-list-item-subtitle>展品 {{ item.exhibitId }} · {{ item.severity === 'major' ? '重大差异' : '轻微差异' }}</v-list-item-subtitle><template #append><v-btn :disabled="item.resolved" color="green" @click="store.resolveDiscrepancy(item.id)">{{ item.resolved ? '已解决' : '确认解决' }}</v-btn></template></v-list-item></v-list>
            </v-window-item>
            <v-window-item value="transfer">
              <div class="d-flex align-center flex-wrap ga-3 pa-4">
                <v-chip v-for="(cabinet, hallName) in store.cabinets" :key="hallName" color="deep-purple" variant="tonal">
                  {{ hallName }} · 占用 {{ store.cabinetOccupancy(hallName) }}/{{ cabinet.capacity }}
                </v-chip>
                <v-spacer />
                <v-btn color="deep-purple" prepend-icon="mdi-swap-horizontal" @click="batchDialog = true">新建放行单</v-btn>
              </div>
              <v-alert v-if="spilledNotice.length" type="warning" class="mx-4 mb-3" closable @click:close="spilledNotice = []">
                柜位剩余容量不足，{{ spilledNotice.length }} 件展品已退回待重新安排：{{ spilledNotice.join('、') }}
              </v-alert>
              <v-list>
                <v-list-item v-for="batch in store.batches" :key="batch.id" class="batch-row">
                  <v-list-item-title>
                    {{ batch.code }} → {{ batch.targetHall }}
                    <v-chip size="small" class="ml-2" :color="batchStatusColor(batch.status)">{{ batchStatusLabel(batch.status) }}</v-chip>
                    <v-chip v-if="batch.envInvalidated" size="small" class="ml-2" color="red" variant="outlined">环境读数已失效，退回复核</v-chip>
                  </v-list-item-title>
                  <v-list-item-subtitle>
                    {{ batch.items.filter((item) => item.arrived).length }}/{{ batch.items.length }} 件到柜 · 经手 {{ batch.createdBy }} · 环境读数：{{ countdown(batch) }}
                    <span v-if="batch.signed.length"> · 已签：{{ batch.signed.join('、') }}</span>
                  </v-list-item-subtitle>
                  <div v-if="batch.status === 'pending' && store.batchBlockReasons(batch).length" class="mt-1">
                    <v-chip v-for="reason in store.batchBlockReasons(batch)" :key="reason" size="x-small" color="red" variant="tonal" class="mr-1">{{ reason }}</v-chip>
                  </div>
                  <div v-if="batch.status === 'in-transit'" class="mt-1">
                    <v-chip
                      v-for="item in batch.items"
                      :key="item.exhibitId"
                      size="small"
                      class="mr-1"
                      :color="item.arrived ? 'green' : 'blue'"
                      :variant="item.arrived ? 'tonal' : 'flat'"
                      @click="store.markArrived(batch.id, item.exhibitId)"
                    >{{ exhibitCode(item.exhibitId) }}{{ item.arrived ? ' ✓' : ' 到柜' }}</v-chip>
                  </div>
                  <template #append>
                    <template v-if="batch.status === 'pending'">
                      <v-btn size="small" variant="text" @click="openEnv(batch.id)">录入环境读数</v-btn>
                      <v-btn size="small" variant="text" :disabled="batch.signed.includes('保管员') || !batch.conditionPassed" @click="store.signBatch(batch.id, '保管员')">保管员签字</v-btn>
                      <v-btn size="small" variant="text" :disabled="batch.signed.includes('布展负责人') || !batch.conditionPassed" @click="store.signBatch(batch.id, '布展负责人')">负责人签字</v-btn>
                      <v-btn size="small" color="deep-purple" :disabled="store.batchBlockReasons(batch).length > 0" @click="store.dispatchBatch(batch.id)">放行过柜</v-btn>
                    </template>
                    <v-btn v-if="batch.status === 'in-transit'" size="small" color="red" variant="text" @click="store.failBatch(batch.id)">标记失败</v-btn>
                    <v-btn v-if="batch.status === 'failed'" size="small" color="deep-purple" @click="store.retryPending(batch.id, '保管员')">重试未到柜（{{ batch.items.filter((item) => !item.arrived).length }} 件）</v-btn>
                  </template>
                </v-list-item>
              </v-list>
            </v-window-item>
          </v-window>
        </v-card>

        <v-dialog v-model="dialog" max-width="560">
          <v-card title="登记新展品">
            <v-card-text><v-form @submit.prevent="submit"><v-text-field v-model="code" label="展品编号" :error-messages="errors.code" /><v-text-field v-model="name" label="展品名称" :error-messages="errors.name" /><v-text-field v-model="lender" label="借展方" :error-messages="errors.lender" /><v-text-field v-model="hall" label="展厅/柜位" :error-messages="errors.hall" /><v-btn type="submit" color="deep-purple" block>写入点交队列</v-btn></v-form></v-card-text>
          </v-card>
        </v-dialog>

        <v-dialog v-model="batchDialog" max-width="560">
          <v-card title="新建转柜放行单">
            <v-card-text>
              <v-select v-model="batchExhibits" :items="store.transferable" item-title="name" item-value="id" label="选择展品（同一批一起过柜）" multiple chips closable-chips />
              <v-select v-model="batchHall" :items="halls" label="目标柜位" />
              <v-alert density="compact" variant="tonal" color="deep-purple">该柜位剩余容量 {{ remainingCapacity }} 件，超出部分将退回重排。</v-alert>
            </v-card-text>
            <v-card-actions><v-spacer /><v-btn @click="batchDialog = false">取消</v-btn><v-btn color="deep-purple" :disabled="!batchExhibits.length" @click="submitBatch">提交放行单</v-btn></v-card-actions>
          </v-card>
        </v-dialog>

        <v-dialog v-model="envDialog" max-width="420">
          <v-card title="录入环境读数">
            <v-card-text>
              <v-text-field v-model.number="envForm.temperature" type="number" label="温度 ℃" />
              <v-text-field v-model.number="envForm.humidity" type="number" label="湿度 %" />
              <v-text-field v-model.number="envForm.light" type="number" label="照度 lux" />
              <v-alert density="compact" variant="tonal">读数 30 分钟内有效；过期后依赖它的条件结论与签字立即失效，批次退回复核。</v-alert>
            </v-card-text>
            <v-card-actions><v-spacer /><v-btn color="deep-purple" @click="saveEnv">保存读数</v-btn></v-card-actions>
          </v-card>
        </v-dialog>

        <v-dialog :model-value="Boolean(selected)" max-width="680" @update:model-value="selected = null">
          <v-card v-if="selected" :title="`${selected.code} · ${selected.name}`">
            <v-card-text>
              <v-timeline side="end" density="compact">
                <v-timeline-item dot-color="green"><b>保管员点收</b><p>核对包装、封条和附件清单。</p><v-btn size="small" :disabled="selected.signed.includes('保管员')" @click="store.sign(selected.id, '保管员')">{{ selected.signed.includes('保管员') ? '已签字' : '保管员签字' }}</v-btn></v-timeline-item>
                <v-timeline-item dot-color="orange"><b>借展方确认</b><p>确认差异项及后续责任。</p><v-btn size="small" :disabled="selected.signed.includes('借展方')" @click="store.sign(selected.id, '借展方')">{{ selected.signed.includes('借展方') ? '已签字' : '借展方签字' }}</v-btn></v-timeline-item>
                <v-timeline-item dot-color="purple"><b>推进阶段</b><p>存在未解决差异或缺少借展方签字时不能推进。</p><v-btn size="small" color="deep-purple" @click="store.advance(selected.id)">推进到下一阶段</v-btn></v-timeline-item>
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
.batch-row { border-bottom: 1px solid #eee; align-items: flex-start; }
</style>
