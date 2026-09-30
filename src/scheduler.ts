/**
 * Agendador que roda dentro do backend (o pg_cron do Supabase não alcança o backend,
 * que só tem endereço interno na VPS).
 *
 * - a cada minuto: envia os lembretes vencidos (compromissos e contas)
 * - de hora em hora (e ao iniciar): gera as ocorrências das contas dos próximos 40 dias
 *
 * Tudo é idempotente: reiniciar o servidor não duplica nada, e lembretes perdidos
 * durante uma queda saem assim que ele volta (até 6 h de atraso; depois disso, são descartados).
 */
import { BILL_COLS, EVENT_COLS, ensureBillOccurrences, type BillRow, type EventRow } from './agent/reminders.js';
import { billReminderText, eventReminderText } from './agent/schedule-format.js';
import { db, type Member } from './db/supabase.js';
import { logOutgoing } from './handlers/log.js';
import { sendText } from './whatsapp/evolution.js';

const MAX_LATE_MS = 6 * 3600 * 1000;
const MAX_ATTEMPTS = 3;

type ReminderRow = {
  id: string;
  family_id: string;
  target_member_id: string;
  kind: string;
  ref_id: string;
  send_at: string;
  sent_at: string | null;
  payload: { attempts?: number; skipped?: string } | null;
};

/** Monta o texto do lembrete a partir do estado ATUAL do banco (o compromisso pode ter mudado). null = não enviar. */
async function buildMessage(r: ReminderRow, now: Date): Promise<string | null> {
  if (r.kind === 'evento') {
    const { data } = await db.from('events').select(EVENT_COLS).eq('id', r.ref_id).maybeSingle();
    const ev = data as EventRow | null;
    if (!ev) return null;
    const start = new Date(ev.starts_at);
    if (start < now) return null; // já começou
    return eventReminderText({ title: ev.title, starts_at: start, location: ev.location, participants: [], remind_before: [] }, now);
  }
  if (r.kind === 'conta' || r.kind === 'conta_vencida') {
    const { data: pay } = await db.from('bill_payments').select('id, bill_id, due_date, paid_at').eq('id', r.ref_id).maybeSingle();
    if (!pay || pay.paid_at) return null;
    const { data: bill } = await db.from('bills').select(BILL_COLS).eq('id', pay.bill_id).maybeSingle();
    const b = bill as BillRow | null;
    if (!b || !b.active) return null;
    return billReminderText({ name: b.name, amount_cents: b.amount_cents, due_date: pay.due_date, paid_at: null }, r.kind, now);
  }
  return null;
}

/** Envia os lembretes vencidos. Devolve quantos foram enviados. */
export async function dispatchDueReminders(now = new Date()): Promise<number> {
  const { data, error } = await db
    .from('reminders')
    .select('id, family_id, target_member_id, kind, ref_id, send_at, sent_at, payload')
    .is('sent_at', null)
    .lte('send_at', now.toISOString())
    .order('send_at', { ascending: true })
    .limit(50);
  if (error) throw error;

  let sent = 0;
  for (const r of (data ?? []) as ReminderRow[]) {
    // Reserva atômica: só um processo consegue marcar sent_at de null para agora
    const { data: claimed } = await db
      .from('reminders')
      .update({ sent_at: now.toISOString() })
      .eq('id', r.id)
      .is('sent_at', null)
      .select('id');
    if (!claimed?.length) continue;

    const markSkipped = (why: string) => db.from('reminders').update({ payload: { ...(r.payload ?? {}), skipped: why } }).eq('id', r.id);

    if (now.getTime() - new Date(r.send_at).getTime() > MAX_LATE_MS) {
      await markSkipped('atrasado demais');
      continue;
    }
    const text = await buildMessage(r, now);
    if (!text) {
      await markSkipped('não se aplica mais');
      continue;
    }
    const { data: m } = await db.from('members').select('id, family_id, name, phone, role, active').eq('id', r.target_member_id).maybeSingle();
    const member = m as Member | null;
    if (!member?.active) {
      await markSkipped('membro inativo');
      continue;
    }
    try {
      const res = await sendText(member.phone, text);
      await logOutgoing(member.phone, text, member, res?.key?.id);
      sent++;
    } catch (err) {
      const attempts = (r.payload?.attempts ?? 0) + 1;
      console.error(`Falha ao enviar lembrete ${r.id} (tentativa ${attempts})`, err);
      // devolve para a fila, até MAX_ATTEMPTS
      await db
        .from('reminders')
        .update({ sent_at: attempts >= MAX_ATTEMPTS ? now.toISOString() : null, payload: { ...(r.payload ?? {}), attempts } })
        .eq('id', r.id);
    }
  }
  return sent;
}

/** Gera ocorrências e lembretes de todas as contas ativas (todas as famílias). */
export async function refreshAllBills(now = new Date()): Promise<void> {
  const { data, error } = await db.from('bills').select(BILL_COLS).eq('active', true);
  if (error) throw error;
  for (const bill of (data ?? []) as BillRow[]) {
    try {
      await ensureBillOccurrences(bill, now);
    } catch (err) {
      console.error(`Falha ao gerar ocorrências da conta ${bill.id}`, err);
    }
  }
}

let timers: NodeJS.Timeout[] = [];
let running = false;

export function startScheduler(log: (msg: string) => void = console.log) {
  const tick = async () => {
    if (running) return; // não sobrepõe execuções lentas
    running = true;
    try {
      const n = await dispatchDueReminders();
      if (n) log(`Lembretes enviados: ${n}`);
    } catch (err) {
      console.error('Erro no agendador de lembretes', err);
    } finally {
      running = false;
    }
  };
  const bills = () => refreshAllBills().catch((err) => console.error('Erro ao gerar contas', err));

  void bills().then(tick);
  timers = [setInterval(tick, 60_000), setInterval(bills, 60 * 60_000)];
  log('Agendador iniciado (lembretes a cada minuto, contas de hora em hora)');
}

export function stopScheduler() {
  timers.forEach(clearInterval);
  timers = [];
}
