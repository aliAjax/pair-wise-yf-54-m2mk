import { defineStore } from 'pinia';

export type Stage = 'arrival' | 'install' | 'return';
export type CheckStatus = 'pending' | 'passed' | 'issue';
export interface Exhibit {
  id: string;
  code: string;
  name: string;
  lender: string;
  hall: string;
  stage: Stage;
  status: CheckStatus;
  signed: string[];
  environment: { temperature: number; humidity: number; light: number };
}
export interface Discrepancy { id: string; exhibitId: string; title: string; severity: 'minor' | 'major'; resolved: boolean; }

export type BatchStatus = 'pending' | 'in-transit' | 'failed' | 'completed';
export interface EnvReading {
  temperature: number;
  humidity: number;
  light: number;
  takenAt: number;
  expiresAt: number;
}
export interface TransferItem { exhibitId: string; arrived: boolean; }
export interface TransferBatch {
  id: string;
  code: string;
  targetHall: string;
  items: TransferItem[];
  status: BatchStatus;
  env: EnvReading | null;
  conditionPassed: boolean;
  signed: string[];
  createdBy: string;
  createdAt: number;
  envInvalidated: boolean;
}
interface Cabinet { capacity: number; }
interface State {
  exhibits: Exhibit[];
  discrepancies: Discrepancy[];
  queued: number;
  batches: TransferBatch[];
  cabinets: Record<string, Cabinet>;
  schemaVersion: number;
}

const SCHEMA_VERSION = 2;
const LEGACY_BATCH_ID = 'batch-legacy';
export const ENV_TTL_MS = 30 * 60 * 1000;

function defaultCabinets(): Record<string, Cabinet> {
  return { 'A2 温湿展柜': { capacity: 10 }, 'B1 开放展区': { capacity: 20 }, 'C3 书画专柜': { capacity: 6 } };
}

const seed: State = {
  exhibits: Array.from({ length: 24 }, (_, index) => ({
    id: `ex-${index + 1}`,
    code: `M${String(index + 1).padStart(3, '0')}`,
    name: ['青铜镜', '釉里红瓷瓶', '石雕佛首', '手抄经卷', '鎏金香炉'][index % 5] + ` ${index + 1}`,
    lender: index % 2 ? '西北博物馆' : '私人借展方',
    hall: index % 3 === 0 ? 'A2 温湿展柜' : 'B1 开放展区',
    stage: index < 8 ? 'arrival' : index < 18 ? 'install' : 'return',
    status: index === 4 ? 'issue' : index < 10 ? 'passed' : 'pending',
    signed: index < 5 ? ['保管员', '借展方'] : index < 10 ? ['保管员'] : [],
    environment: { temperature: 20 + index % 3, humidity: 48 + index % 8, light: 120 + index * 3 }
  })),
  discrepancies: [
    { id: 'd1', exhibitId: 'ex-5', title: '封条编号与交接单不一致', severity: 'major', resolved: false },
    { id: 'd2', exhibitId: 'ex-7', title: '木箱边角轻微磕碰', severity: 'minor', resolved: false }
  ],
  queued: 0,
  batches: [],
  cabinets: defaultCabinets(),
  schemaVersion: SCHEMA_VERSION
};

// 旧数据升级：没有批次号的展品补进历史默认批次，展品上的旧签字原样保留。
function migrate(raw: State): State {
  const state = raw;
  if (!Array.isArray(state.batches)) state.batches = [];
  if (!state.cabinets || typeof state.cabinets !== 'object') state.cabinets = defaultCabinets();
  const assigned = new Set(state.batches.flatMap((batch) => batch.items.map((item) => item.exhibitId)));
  const orphans = state.exhibits.filter((exhibit) => !assigned.has(exhibit.id));
  if (orphans.length) {
    let legacy = state.batches.find((batch) => batch.id === LEGACY_BATCH_ID);
    if (!legacy) {
      legacy = {
        id: LEGACY_BATCH_ID,
        code: 'LEGACY-000',
        targetHall: '历史默认批次',
        items: [],
        status: 'completed',
        env: null,
        conditionPassed: false,
        signed: [],
        createdBy: '系统迁移',
        createdAt: 0,
        envInvalidated: false
      };
      state.batches.unshift(legacy);
    }
    const inLegacy = new Set(legacy.items.map((item) => item.exhibitId));
    for (const exhibit of orphans) {
      if (!inLegacy.has(exhibit.id)) legacy.items.push({ exhibitId: exhibit.id, arrived: true });
    }
  }
  state.schemaVersion = SCHEMA_VERSION;
  return state;
}

function load(): State {
  const saved = localStorage.getItem('yf54-exhibition-state');
  return migrate(saved ? JSON.parse(saved) as State : seed);
}

let batchSeq = 1;

export const useExhibitionStore = defineStore('exhibition', {
  state: () => load(),
  getters: {
    unresolved: (state) => state.discrepancies.filter((item) => !item.resolved).length,
    stageCounts: (state) => ({ arrival: state.exhibits.filter((item) => item.stage === 'arrival').length, install: state.exhibits.filter((item) => item.stage === 'install').length, return: state.exhibits.filter((item) => item.stage === 'return').length }),
    activeBatches: (state) => state.batches.filter((batch) => batch.status === 'pending' || batch.status === 'in-transit'),
    // 柜位占用 = 已在柜展品 + 生效批次中未到柜的展品（并发提交时后来方只能看到剩余容量）
    cabinetOccupancy: (state) => (hall: string) => {
      const seated = state.exhibits.filter((exhibit) => exhibit.hall === hall).length;
      const reserved = state.batches
        .filter((batch) => batch.targetHall === hall && (batch.status === 'pending' || batch.status === 'in-transit'))
        .reduce((total, batch) => total + batch.items.filter((item) => !item.arrived).length, 0);
      return seated + reserved;
    },
    transferable: (state) => {
      const locked = new Set(state.batches
        .filter((batch) => batch.status === 'pending' || batch.status === 'in-transit')
        .flatMap((batch) => batch.items.map((item) => item.exhibitId)));
      return state.exhibits.filter((exhibit) => !locked.has(exhibit.id));
    }
  },
  actions: {
    persist() { localStorage.setItem('yf54-exhibition-state', JSON.stringify(this.$state)); },
    markQueued() { this.queued += 1; this.persist(); },
    setCondition(id: string, status: CheckStatus) { const exhibit = this.exhibits.find((item) => item.id === id); if (exhibit) { exhibit.status = status; this.markQueued(); } },
    sign(id: string, role: string) { const exhibit = this.exhibits.find((item) => item.id === id); if (!exhibit || exhibit.signed.includes(role)) return; exhibit.signed.push(role); this.markQueued(); },
    advance(id: string) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit || !exhibit.signed.includes('借展方') || this.discrepancies.some((item) => item.exhibitId === id && !item.resolved)) return;
      exhibit.stage = exhibit.stage === 'arrival' ? 'install' : exhibit.stage === 'install' ? 'return' : 'return';
      this.markQueued();
    },
    resolveDiscrepancy(id: string) { const item = this.discrepancies.find((entry) => entry.id === id); if (item) { item.resolved = true; this.markQueued(); } },
    addExhibit(payload: Pick<Exhibit, 'code' | 'name' | 'lender' | 'hall'>) {
      this.exhibits.unshift({ id: `ex-${Date.now()}`, ...payload, stage: 'arrival', status: 'pending', signed: [], environment: { temperature: 20, humidity: 50, light: 150 } });
      this.markQueued();
    },
    syncQueue() { this.queued = 0; this.persist(); },

    exhibitById(id: string) { return this.exhibits.find((item) => item.id === id); },
    unresolvedFor(exhibitId: string) { return this.discrepancies.filter((item) => item.exhibitId === exhibitId && !item.resolved); },
    envValid(batch: TransferBatch) { return Boolean(batch.env && batch.env.expiresAt > Date.now()); },
    batchBlockReasons(batch: TransferBatch): string[] {
      const reasons: string[] = [];
      if (!batch.env) reasons.push('未录入环境读数');
      else if (!this.envValid(batch)) reasons.push('环境读数已过期');
      if (!batch.conditionPassed) reasons.push('条件结论未通过');
      for (const role of ['保管员', '布展负责人']) if (!batch.signed.includes(role)) reasons.push(`缺少${role}签字`);
      const blocked = batch.items.filter((item) => this.unresolvedFor(item.exhibitId).length).length;
      if (blocked) reasons.push(`${blocked} 件展品存在未解决差异`);
      return reasons;
    },

    // 同一批放行单带多件展品；柜位容量不足时按剩余容量装入，超出部分退回重排
    createBatch(exhibitIds: string[], targetHall: string, createdBy: string) {
      const cabinet = this.cabinets[targetHall];
      const remaining = cabinet ? Math.max(cabinet.capacity - this.cabinetOccupancy(targetHall), 0) : exhibitIds.length;
      const accepted = exhibitIds.slice(0, remaining);
      const spilled = exhibitIds.slice(remaining);
      const batch: TransferBatch = {
        id: `batch-${Date.now()}-${batchSeq++}`,
        code: `REL-${String(this.batches.length + batchSeq).padStart(3, '0')}`,
        targetHall,
        items: accepted.map((exhibitId) => ({ exhibitId, arrived: false })),
        status: 'pending',
        env: null,
        conditionPassed: false,
        signed: [],
        createdBy,
        createdAt: Date.now(),
        envInvalidated: false
      };
      this.batches.unshift(batch);
      this.markQueued();
      return { batch, spilled };
    },
    recordEnv(id: string, reading: { temperature: number; humidity: number; light: number }) {
      const batch = this.batches.find((item) => item.id === id);
      if (!batch || batch.status === 'completed') return;
      batch.env = { ...reading, takenAt: Date.now(), expiresAt: Date.now() + ENV_TTL_MS };
      batch.conditionPassed = true;
      batch.envInvalidated = false;
      this.markQueued();
    },
    signBatch(id: string, role: string) {
      const batch = this.batches.find((item) => item.id === id);
      if (!batch || batch.status !== 'pending' || batch.signed.includes(role)) return;
      if (!batch.conditionPassed || !this.envValid(batch)) return;
      batch.signed.push(role);
      this.markQueued();
    },
    // 环境读数过期：依赖它的条件结论与签字立即失效，批次退回复核
    checkEnvExpiry() {
      const now = Date.now();
      let changed = false;
      for (const batch of this.batches) {
        if (!batch.env || batch.env.expiresAt > now) continue;
        if (batch.conditionPassed || batch.signed.length || batch.status === 'in-transit') {
          batch.conditionPassed = false;
          batch.signed = [];
          batch.envInvalidated = true;
          if (batch.status === 'in-transit') batch.status = 'pending';
          changed = true;
        }
      }
      if (changed) this.markQueued();
    },
    dispatchBatch(id: string) {
      const batch = this.batches.find((item) => item.id === id);
      if (!batch || batch.status !== 'pending') return;
      this.checkEnvExpiry();
      if (this.batchBlockReasons(batch).length) return;
      batch.status = 'in-transit';
      this.markQueued();
    },
    markArrived(batchId: string, exhibitId: string) {
      const batch = this.batches.find((item) => item.id === batchId);
      const item = batch?.items.find((entry) => entry.exhibitId === exhibitId);
      if (!batch || !item || batch.status !== 'in-transit' || item.arrived) return;
      item.arrived = true;
      const exhibit = this.exhibitById(exhibitId);
      if (exhibit) exhibit.hall = batch.targetHall;
      if (batch.items.every((entry) => entry.arrived)) batch.status = 'completed';
      this.markQueued();
    },
    // 转柜失败：原批次与已到柜记录全部保留
    failBatch(id: string) {
      const batch = this.batches.find((item) => item.id === id);
      if (!batch || batch.status !== 'in-transit') return;
      batch.status = 'failed';
      this.markQueued();
    },
    // 只重试未到柜的展品，原批次留在失败状态作为历史记录
    retryPending(id: string, createdBy: string) {
      const batch = this.batches.find((item) => item.id === id);
      if (!batch || batch.status !== 'failed') return null;
      const pendingIds = batch.items.filter((item) => !item.arrived).map((item) => item.exhibitId);
      if (!pendingIds.length) return null;
      return this.createBatch(pendingIds, batch.targetHall, createdBy);
    }
  }
});
