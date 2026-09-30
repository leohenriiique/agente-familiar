/** Supabase falso em memória + fetch falso (Claude, OpenAI, Evolution) para as simulações. */
import assert from 'node:assert/strict';
import { after, before } from 'node:test';

// ---------------------------------------------------------------- banco falso
type Row = Record<string, any>;
export const tables: Record<string, Row[]> = {};
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

class Query {
  private filters: ((r: Row) => boolean)[] = [];
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private payload: any;
  private mode: 'many' | 'single' | 'maybe' = 'many';
  private orderBy?: { col: string; asc: boolean };
  private lim?: number;
  private head = false;
  constructor(private table: string) {}
  select(_cols?: string, opts?: { head?: boolean }) { if (opts?.head) this.head = true; return this; }
  insert(p: any) { this.op = 'insert'; this.payload = p; return this; }
  update(p: any) { this.op = 'update'; this.payload = p; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(c: string, v: any) { this.filters.push((r) => r[c] === v); return this; }
  in(c: string, vs: any[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: any) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  not(c: string, _op: string, _v: any) { this.filters.push((r) => r[c] !== null && r[c] !== undefined); return this; }
  gte(c: string, v: any) { this.filters.push((r) => r[c] >= v); return this; }
  order(col: string, o?: { ascending?: boolean }) { this.orderBy = { col, asc: o?.ascending ?? true }; return this; }
  limit(n: number) { this.lim = n; return this; }
  single() { this.mode = 'single'; return this; }
  maybeSingle() { this.mode = 'maybe'; return this; }
  then(res: any, rej: any) { return Promise.resolve().then(() => this.exec()).then(res, rej); }

  private exec() {
    const t = (tables[this.table] ??= []);
    let rows: Row[];
    if (this.op === 'insert') {
      const r = { id: uuid(), created_at: new Date(Date.now() + seq).toISOString(), ...this.payload };
      if (this.table === 'messages' && r.wa_message_id && t.some((x) => x.wa_message_id === r.wa_message_id)) {
        return { data: null, error: { code: '23505', message: 'duplicate' } };
      }
      t.push(r);
      rows = [r];
    } else {
      rows = t.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === 'update') rows.forEach((r) => Object.assign(r, this.payload));
      if (this.op === 'delete') tables[this.table] = t.filter((r) => !rows.includes(r));
    }
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      rows = [...rows].sort((a, b) => (a[col] > b[col] ? 1 : -1) * (asc ? 1 : -1));
    }
    if (this.lim !== undefined) rows = rows.slice(0, this.lim);
    // "join" categories(name) nas consultas de gastos
    if (this.table === 'expenses') {
      rows = rows.map((r) => ({ ...r, categories: tables.categories?.find((c) => c.id === r.category_id) ?? null }));
    }
    if (this.head) return { count: rows.length, error: null };
    if (this.mode === 'single') return rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: 'not found' } };
    if (this.mode === 'maybe') return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }
}

export const uploads: string[] = [];
export const fakeDb = {
  from: (t: string) => new Query(t),
  storage: { from: () => ({ upload: async (path: string) => { uploads.push(path); return { error: null }; } }) },
};

// ---------------------------------------------------------------- fetch falso
export type ClaudeScript = (body: any) => any;
export const state = { claudeQueue: [] as ClaudeScript[], transcription: '' };
export const claudeRequests: any[] = [];
export const sent: { number: string; text: string }[] = [];


export const toolUse = (name: string, input: Record<string, unknown>) => () => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: `tu_${++seq}`, name, input }],
});
export const say = (text: string) => () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (u.includes('api.anthropic.com')) {
      const body = JSON.parse(init.body);
      claudeRequests.push(body);
      const next = state.claudeQueue.shift();
      if (!next) throw new Error('Claude chamado mais vezes que o roteiro');
      return json(next(body));
    }
    if (u.includes('api.openai.com')) {
      assert.ok(init.body instanceof FormData);
      return json({ text: state.transcription });
    }
    if (u.includes('/message/sendText/')) {
      const b = JSON.parse(init.body);
      sent.push({ number: b.number, text: b.text });
      return json({ key: { id: `OUT${++seq}` } }, 201);
    }
    if (u.includes('/chat/sendPresence/')) return json({});
    if (u.includes('/chat/getBase64FromMediaMessage/')) return json({ base64: Buffer.from('media').toString('base64'), mimetype: 'image/jpeg' });
    throw new Error(`fetch inesperado: ${u}`);
  }) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; });

