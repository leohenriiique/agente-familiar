import { db } from '../db/supabase.js';
import { billReminderTimes, dueDatesBetween, eventReminderTimes, localYmd, type BillRule } from './schedule-format.js';

export type EventRow = {
  id: string;
  family_id: string;
  created_by: string | null;
  title: string;
  starts_at: string;
  ends_at: string | null;
  location: string | null;
  remind_before: number[] | null;
  participants: string[] | null;
};

export type BillRow = BillRule & {
  id: string;
  family_id: string;
  name: string;
  amount_cents: number | null;
  remind_days_before: number[] | null;
  active: boolean;
  created_by: string | null;
  created_at: string | null;
};

export const EVENT_COLS = 'id, family_id, created_by, title, starts_at, ends_at, location, remind_before, participants';
export const BILL_COLS = 'id, family_id, name, amount_cents, due_day, due_month, due_date, recurrence, remind_days_before, active, created_by, created_at';

const REMINDER_CONFLICT = 'kind,ref_id,target_member_id,send_at';

/** Apaga lembretes ainda não enviados de um compromisso ou ocorrência de conta. */
export async function cancelPendingReminders(refIds: string[], kinds: string[]) {
  if (!refIds.length) return;
  const { error } = await db.from('reminders').delete().in('ref_id', refIds).in('kind', kinds).is('sent_at', null);
  if (error) throw error;
}

/** (Re)cria os lembretes de um compromisso: um por participante por horário. */
export async function scheduleEventReminders(ev: EventRow, now = new Date()): Promise<number> {
  await cancelPendingReminders([ev.id], ['evento']);
  const targets = ev.participants?.length ? ev.participants : ev.created_by ? [ev.created_by] : [];
  const times = eventReminderTimes(new Date(ev.starts_at), ev.remind_before ?? [1440, 60], now);
  const rows = targets.flatMap((member) =>
    times.map((at) => ({ family_id: ev.family_id, target_member_id: member, kind: 'evento', ref_id: ev.id, send_at: at.toISOString() })),
  );
  if (!rows.length) return 0;
  const { error } = await db.from('reminders').upsert(rows, { onConflict: REMINDER_CONFLICT, ignoreDuplicates: true });
  if (error) throw error;
  return rows.length;
}

/** Quem recebe lembrete de conta: quem cadastrou + admins da família. */
async function billRecipients(bill: BillRow): Promise<string[]> {
  const { data, error } = await db.from('members').select('id').eq('family_id', bill.family_id).eq('role', 'admin').eq('active', true);
  if (error) throw error;
  return [...new Set([...(data ?? []).map((m: { id: string }) => m.id), ...(bill.created_by ? [bill.created_by] : [])])];
}

/**
 * Gera as ocorrências da conta que vencem nos próximos 40 dias (idempotente)
 * e os lembretes das que ainda não foram pagas. Roda no cadastro e de hora em hora.
 * Devolve os vencimentos gerados/confirmados.
 */
export async function ensureBillOccurrences(bill: BillRow, now = new Date()): Promise<string[]> {
  if (!bill.active) return [];
  const today = localYmd(now);
  const created = bill.created_at ? localYmd(new Date(bill.created_at)) : today;
  const from = created > today ? created : today;
  const dues = dueDatesBetween(bill, from);
  if (!dues.length) return [];

  const { error: upErr } = await db
    .from('bill_payments')
    .upsert(dues.map((due_date) => ({ bill_id: bill.id, due_date })), { onConflict: 'bill_id,due_date', ignoreDuplicates: true });
  if (upErr) throw upErr;

  const { data: pays, error } = await db
    .from('bill_payments')
    .select('id, due_date, paid_at')
    .eq('bill_id', bill.id)
    .in('due_date', dues);
  if (error) throw error;

  const recipients = await billRecipients(bill);
  const rows = (pays ?? [])
    .filter((p: { paid_at: string | null }) => !p.paid_at)
    .flatMap((p: { id: string; due_date: string }) =>
      billReminderTimes(p.due_date, bill.remind_days_before ?? [3, 0], now).flatMap((t) =>
        recipients.map((member) => ({
          family_id: bill.family_id, target_member_id: member, kind: t.kind, ref_id: p.id, send_at: t.at.toISOString(),
        })),
      ),
    );
  if (rows.length) {
    const { error: rErr } = await db.from('reminders').upsert(rows, { onConflict: REMINDER_CONFLICT, ignoreDuplicates: true });
    if (rErr) throw rErr;
  }
  return dues;
}
