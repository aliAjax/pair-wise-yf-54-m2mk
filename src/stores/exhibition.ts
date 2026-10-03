import { defineStore } from 'pinia';

export type Stage = 'arrival' | 'install' | 'return';
export type CheckStatus = 'pending' | 'passed' | 'issue';
export type OrderStatus = 'pending' | 'completed' | 'partial' | 'failed' | 'archived';

/** 环境读数：带采集时间戳，超过有效期后依赖它的结论与签字失效 */
export interface EnvironmentReading {
  temperature: number;
  humidity: number;
  light: number;
  measuredAt: number;
  validForMs: number;
}

export interface Exhibit {
  id: string;
  code: string;
  name: string;
  lender: string;
  hall: string;
  cabinetId: string;
  batchId: string;
  stage: Stage;
  status: CheckStatus;
  signed: string[];
  environment: EnvironmentReading;
}

export interface Cabinet {
  id: string;
  code: string;
  name: string;
  capacity: number;
}

/** 某件展品被分配到某个柜位的到柜记录 */
export interface Arrival {
  exhibitId: string;
  cabinetId: string;
  arrivedAt: number;
}

/** 放行单 / 转柜批次：同一批放行单带多件展品一起过柜 */
export interface ReleaseOrder {
  id: string;
  code: string;
  exhibitIds: string[];
  toCabinetId: string;
  status: OrderStatus;
  createdAt: number;
  submittedAt: number | null;
  arrivals: Arrival[];
  failedIds: string[];
  note?: string;
}

export interface Discrepancy {
  id: string;
  exhibitId: string;
  title: string;
  severity: 'minor' | 'major';
  resolved: boolean;
}

interface State {
  version: number;
  exhibits: Exhibit[];
  cabinets: Cabinet[];
  orders: ReleaseOrder[];
  discrepancies: Discrepancy[];
  queued: number;
}

const STORAGE_KEY = 'yf54-exhibition-state';
const CURRENT_VERSION = 2;
export const LEGACY_BATCH_ID = 'BATCH-HIST-DEFAULT';
export const DEFAULT_READING_TTL = 30 * 60 * 1000; // 环境读数有效期 30 分钟

const now = () => Date.now();

function makeReading(partial: Partial<EnvironmentReading> = {}): EnvironmentReading {
  return {
    temperature: partial.temperature ?? 20,
    humidity: partial.humidity ?? 50,
    light: partial.light ?? 150,
    measuredAt: partial.measuredAt ?? now(),
    validForMs: partial.validForMs ?? DEFAULT_READING_TTL
  };
}

const seedCabinets: Cabinet[] = [
  { id: 'C1', code: 'A1', name: 'A1 恒温展柜', capacity: 5 },
  { id: 'C2', code: 'A2', name: 'A2 温湿展柜', capacity: 5 },
  { id: 'C3', code: 'B1', name: 'B1 开放展区', capacity: 6 },
  { id: 'C4', code: 'B2', name: 'B2 独立展柜', capacity: 4 },
  { id: 'C5', code: 'C1', name: 'C1 密集展柜', capacity: 6 },
  { id: 'C6', code: 'C2', name: 'C2 备用展柜', capacity: 4 }
];

function buildSeed(): State {
  const exhibits: Exhibit[] = Array.from({ length: 24 }, (_, index) => {
    const cabinetId = `C${(index % 6) + 1}`;
    const cabinet = seedCabinets.find((c) => c.id === cabinetId)!;
    return {
      id: `ex-${index + 1}`,
      code: `M${String(index + 1).padStart(3, '0')}`,
      name: ['青铜镜', '釉里红瓷瓶', '石雕佛首', '手抄经卷', '鎏金香炉'][index % 5] + ` ${index + 1}`,
      lender: index % 2 ? '西北博物馆' : '私人借展方',
      hall: cabinet.name,
      cabinetId,
      batchId: LEGACY_BATCH_ID,
      stage: index < 8 ? 'arrival' : index < 18 ? 'install' : 'return',
      status: index === 4 ? 'issue' : index < 10 ? 'passed' : 'pending',
      signed: index < 5 ? ['保管员', '借展方'] : index < 10 ? ['保管员'] : [],
      environment: makeReading({ temperature: 20 + (index % 3), humidity: 48 + (index % 8), light: 120 + index * 3 })
    };
  });

  const legacyOrder: ReleaseOrder = {
    id: LEGACY_BATCH_ID,
    code: '历史默认批次',
    exhibitIds: exhibits.map((e) => e.id),
    toCabinetId: '',
    status: 'archived',
    createdAt: now(),
    submittedAt: now(),
    arrivals: exhibits.map((e) => ({ exhibitId: e.id, cabinetId: e.cabinetId, arrivedAt: now() })),
    failedIds: [],
    note: '系统升级前已有展品自动补入，旧签字保留'
  };

  return {
    version: CURRENT_VERSION,
    exhibits,
    cabinets: seedCabinets,
    orders: [legacyOrder],
    discrepancies: [
      { id: 'd1', exhibitId: 'ex-5', title: '封条编号与交接单不一致', severity: 'major', resolved: false },
      { id: 'd2', exhibitId: 'ex-7', title: '木箱边角轻微磕碰', severity: 'minor', resolved: false }
    ],
    queued: 0
  };
}

function inferCabinet(hall: string | undefined, cabinets: Cabinet[]): string {
  if (hall) {
    const hit = cabinets.find((c) => hall.includes(c.name) || c.name.includes(hall));
    if (hit) return hit.id;
  }
  return cabinets[0]?.id ?? 'C3';
}

/** v1 -> v2：补批次号、补柜位、补环境读数时间戳，旧签字原样保留 */
function migrate(saved: any): State {
  const base = buildSeed();
  const cabinets: Cabinet[] = Array.isArray(saved.cabinets) && saved.cabinets.length ? saved.cabinets : base.cabinets;

  const exhibits: Exhibit[] = (Array.isArray(saved.exhibits) ? saved.exhibits : []).map((e: any) => {
    const cabinetId = e.cabinetId ?? inferCabinet(e.hall, cabinets);
    const cabinet = cabinets.find((c) => c.id === cabinetId);
    return {
      id: String(e.id),
      code: String(e.code ?? ''),
      name: String(e.name ?? ''),
      lender: String(e.lender ?? ''),
      hall: e.hall ?? cabinet?.name ?? '',
      cabinetId,
      batchId: e.batchId ?? LEGACY_BATCH_ID, // 没有批次号的展品补进历史默认批次
      stage: (e.stage as Stage) ?? 'arrival',
      status: (e.status as CheckStatus) ?? 'pending',
      signed: Array.isArray(e.signed) ? [...e.signed] : [], // 旧签字不能丢
      environment: makeReading({
        temperature: e.environment?.temperature,
        humidity: e.environment?.humidity,
        light: e.environment?.light,
        measuredAt: e.environment?.measuredAt,
        validForMs: e.environment?.validForMs
      })
    };
  });

  const legacyIds = exhibits.filter((e) => e.batchId === LEGACY_BATCH_ID).map((e) => e.id);
  let orders: ReleaseOrder[] = Array.isArray(saved.orders) ? saved.orders : [];
  if (legacyIds.length && !orders.some((o) => o.id === LEGACY_BATCH_ID)) {
    orders = [
      {
        id: LEGACY_BATCH_ID,
        code: '历史默认批次',
        exhibitIds: legacyIds,
        toCabinetId: '',
        status: 'archived',
        createdAt: now(),
        submittedAt: now(),
        arrivals: legacyIds.map((id) => {
          const ex = exhibits.find((e) => e.id === id)!;
          return { exhibitId: id, cabinetId: ex.cabinetId, arrivedAt: now() };
        }),
        failedIds: [],
        note: '系统升级前已有展品自动补入，旧签字保留'
      },
      ...orders
    ];
  }

  return {
    version: CURRENT_VERSION,
    exhibits,
    cabinets,
    orders,
    discrepancies: Array.isArray(saved.discrepancies) ? saved.discrepancies : [],
    queued: typeof saved.queued === 'number' ? saved.queued : 0
  };
}

function load(): State {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return buildSeed();
  try {
    const parsed = JSON.parse(raw);
    if (parsed.version !== CURRENT_VERSION) return migrate(parsed);
    return parsed as State;
  } catch {
    return buildSeed();
  }
}

/**
 * 容量分配：按剩余容量重排。
 * 先尽量填满目标柜位，再把溢出部分按剩余容量从大到小分流到其它柜位，
 * 全部柜位都放不下的展品记为未到柜（failed），可只重试这些展品。
 */
function allocate(state: State, exhibitIds: string[], toCabinetId: string): { arrivals: Arrival[]; failed: string[] } {
  const moving = new Set(exhibitIds);
  const occupied: Record<string, number> = {};
  const remaining: Record<string, number> = {};
  for (const c of state.cabinets) {
    occupied[c.id] = 0;
  }
  for (const e of state.exhibits) {
    if (moving.has(e.id)) continue; // 转柜展品离开原柜，腾出容量
    occupied[e.cabinetId] = (occupied[e.cabinetId] ?? 0) + 1;
  }
  for (const c of state.cabinets) {
    remaining[c.id] = c.capacity - (occupied[c.id] ?? 0);
  }

  const others = state.cabinets
    .filter((c) => c.id !== toCabinetId)
    .sort((a, b) => (remaining[b.id] ?? 0) - (remaining[a.id] ?? 0));
  const plan = [toCabinetId, ...others.map((c) => c.id)].filter((cid, idx, arr) => cid && arr.indexOf(cid) === idx);

  const arrivals: Arrival[] = [];
  const failed: string[] = [];
  for (const id of exhibitIds) {
    const placed = plan.find((cid) => (remaining[cid] ?? 0) > 0);
    if (placed) {
      arrivals.push({ exhibitId: id, cabinetId: placed, arrivedAt: now() });
      remaining[placed] -= 1;
    } else {
      failed.push(id);
    }
  }
  return { arrivals, failed };
}

export const useExhibitionStore = defineStore('exhibition', {
  state: (): State => load(),
  getters: {
    unresolved: (state) => state.discrepancies.filter((item) => !item.resolved).length,
    stageCounts: (state) => ({
      arrival: state.exhibits.filter((item) => item.stage === 'arrival').length,
      install: state.exhibits.filter((item) => item.stage === 'install').length,
      return: state.exhibits.filter((item) => item.stage === 'return').length
    }),
    /** 环境读数已过期的展品数 */
    expiredCount: (state) => state.exhibits.filter((e) => now() - e.environment.measuredAt > e.environment.validForMs).length,
    /** 柜位容量视图：已占 / 剩余 */
    cabinetRows: (state) =>
      state.cabinets.map((c) => {
        const occupied = state.exhibits.filter((e) => e.cabinetId === c.id).length;
        return { ...c, occupied, remaining: c.capacity - occupied };
      }),
    /** 放行单按创建时间倒序 */
    sortedOrders: (state) => [...state.orders].sort((a, b) => b.createdAt - a.createdAt)
  },
  actions: {
    persist() {
      this.version = CURRENT_VERSION;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.$state));
    },
    markQueued() {
      this.queued += 1;
      this.persist();
    },
    isEnvExpired(exhibit: Exhibit): boolean {
      return now() - exhibit.environment.measuredAt > exhibit.environment.validForMs;
    },
    /**
     * 环境读数过期后，依赖它的条件结论和签字立即失效并退回复核。
     * 由界面定时调用 + 加载时调用。
     */
    sweepExpired() {
      let changed = false;
      for (const e of this.exhibits) {
        if (this.isEnvExpired(e) && (e.status !== 'pending' || e.signed.length > 0)) {
          e.status = 'pending';
          e.signed = [];
          changed = true;
        }
      }
      if (changed) this.persist();
    },
    /** 重新采集环境读数，刷新有效期 */
    refreshEnvironment(id: string, values?: Partial<EnvironmentReading>) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit) return;
      exhibit.environment = makeReading({ ...exhibit.environment, ...values, measuredAt: now() });
      this.markQueued();
    },
    setCondition(id: string, status: CheckStatus) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit || this.isEnvExpired(exhibit)) return; // 读数过期，结论失效，须先刷新复核
      exhibit.status = status;
      this.markQueued();
    },
    sign(id: string, role: string) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit || exhibit.signed.includes(role) || this.isEnvExpired(exhibit)) return;
      exhibit.signed.push(role);
      this.markQueued();
    },
    advance(id: string) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit || !exhibit.signed.includes('借展方') || this.isEnvExpired(exhibit)) return;
      if (this.discrepancies.some((item) => item.exhibitId === id && !item.resolved)) return;
      exhibit.stage = exhibit.stage === 'arrival' ? 'install' : exhibit.stage === 'install' ? 'return' : 'return';
      this.markQueued();
    },
    resolveDiscrepancy(id: string) {
      const item = this.discrepancies.find((entry) => entry.id === id);
      if (item) {
        item.resolved = true;
        this.markQueued();
      }
    },
    addExhibit(payload: Pick<Exhibit, 'code' | 'name' | 'lender' | 'hall'> & { cabinetId?: string }) {
      const cabinetId = payload.cabinetId ?? inferCabinet(payload.hall, this.cabinets);
      const cabinet = this.cabinets.find((c) => c.id === cabinetId);
      this.exhibits.unshift({
        id: `ex-${Date.now()}`,
        code: payload.code,
        name: payload.name,
        lender: payload.lender,
        hall: cabinet?.name ?? payload.hall,
        cabinetId,
        batchId: LEGACY_BATCH_ID,
        stage: 'arrival',
        status: 'pending',
        signed: [],
        environment: makeReading()
      });
      this.markQueued();
    },
    /** 新建放行单：同一批放行单带多件展品一起过柜 */
    createOrder(exhibitIds: string[], toCabinetId: string): { ok: boolean; reason?: string; order?: ReleaseOrder } {
      if (!exhibitIds.length) return { ok: false, reason: '请选择要转柜的展品' };
      if (!toCabinetId) return { ok: false, reason: '请选择目标柜位' };
      const targets = this.exhibits.filter((e) => exhibitIds.includes(e.id));
      if (targets.length !== exhibitIds.length) return { ok: false, reason: '部分展品不存在' };
      // 未解决的差异项继续挡住这批展品
      const blocked = targets.filter((e) => this.discrepancies.some((d) => d.exhibitId === e.id && !d.resolved));
      if (blocked.length) return { ok: false, reason: `存在未解决差异项，无法转柜：${blocked.map((e) => e.code).join('、')}` };
      // 读数过期 → 结论/签字失效，退回复核后才能转柜
      const expired = targets.filter((e) => this.isEnvExpired(e));
      if (expired.length) return { ok: false, reason: `环境读数已过期，请刷新并复核：${expired.map((e) => e.code).join('、')}` };

      const order: ReleaseOrder = {
        id: `RO-${Date.now()}`,
        code: `放行单 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        exhibitIds: [...exhibitIds],
        toCabinetId,
        status: 'pending',
        createdAt: now(),
        submittedAt: null,
        arrivals: [],
        failedIds: []
      };
      this.orders.unshift(order);
      this.markQueued();
      return { ok: true, order };
    },
    /** 提交放行单：按剩余容量重排，部分柜位放不下时记为未到柜 */
    submitOrder(orderId: string) {
      const order = this.orders.find((o) => o.id === orderId);
      if (!order || order.status === 'archived' || order.status === 'completed') return;
      const pending = order.exhibitIds.filter((id) => !order.arrivals.some((a) => a.exhibitId === id));
      const { arrivals, failed } = allocate(this.$state, pending, order.toCabinetId);
      for (const a of arrivals) {
        const ex = this.exhibits.find((e) => e.id === a.exhibitId);
        if (ex) {
          ex.cabinetId = a.cabinetId;
          ex.hall = this.cabinets.find((c) => c.id === a.cabinetId)?.name ?? ex.hall;
          ex.batchId = order.id;
        }
      }
      order.arrivals.push(...arrivals);
      order.failedIds = failed;
      order.submittedAt = now();
      order.status = failed.length === 0 ? 'completed' : arrivals.length === 0 ? 'failed' : 'partial';
      this.markQueued();
    },
    /** 转柜失败后保留原批次，只重试未到柜的展品 */
    retryOrder(orderId: string) {
      const order = this.orders.find((o) => o.id === orderId);
      if (!order || !order.failedIds.length) return;
      const { arrivals, failed } = allocate(this.$state, [...order.failedIds], order.toCabinetId);
      for (const a of arrivals) {
        const ex = this.exhibits.find((e) => e.id === a.exhibitId);
        if (ex) {
          ex.cabinetId = a.cabinetId;
          ex.hall = this.cabinets.find((c) => c.id === a.cabinetId)?.name ?? ex.hall;
          ex.batchId = order.id;
        }
      }
      order.arrivals.push(...arrivals);
      order.failedIds = failed;
      order.submittedAt = now();
      order.status = failed.length === 0 ? 'completed' : 'partial';
      this.markQueued();
    },
    syncQueue() {
      this.queued = 0;
      this.persist();
    }
  }
});
