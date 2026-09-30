/**
 * Datas e textos da agenda e das contas (funções puras, testadas em tests/phase4.test.ts).
 * Tudo no horário de São Paulo, que é sempre -03:00 (sem horário de verão desde 2019).
 */
import { formatBRL, formatDateTime, TZ } from './format.js';

const SP = '-03:00';
export const REMINDER_HOUR = '09:00'; // lembretes de contas saem às 9h

/** "2026-10-15" + "09:00" → instante em São Paulo. */
export function spAt(ymd: string, hm = '00:00'): Date {
  return new Date(`${ymd}T${hm}:00${SP}`);
}

/** Data de parede em SP: "2026-09-30". */
export function localYmd(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate(); // month 1-12
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Vencimento num mês: dia 31 em fevereiro vira 28/29, e assim por diante. */
export function dueInMonth(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(Math.min(day, daysInMonth(year, month)))}`;
}

export type BillRule = {
  recurrence: 'mensal' | 'anual' | 'unica';
  due_day: number | null;
  due_month: number | null;
  due_date: string | null;
};

/**
 * Vencimentos a gerar agora: de `fromYmd` (inclusive) até `fromYmd + horizonDays`.
 * `fromYmd` deve ser o maior entre hoje e o dia do cadastro, para não criar
 * "conta vencida" de um mês em que a conta nem existia.
 */
export function dueDatesBetween(rule: BillRule, fromYmd: string, horizonDays = 40): string[] {
  const toYmd = addDays(fromYmd, horizonDays);
  const out: string[] = [];
  if (rule.recurrence === 'unica') {
    if (rule.due_date && rule.due_date >= fromYmd && rule.due_date <= toYmd) out.push(rule.due_date);
    return out;
  }
  if (!rule.due_day) return out;
  let y = Number(fromYmd.slice(0, 4));
  let m = Number(fromYmd.slice(5, 7));
  for (let i = 0; i < 15; i++) {
    if (rule.recurrence === 'mensal' || m === rule.due_month) {
      const d = dueInMonth(y, m, rule.due_day);
      if (d > toYmd) break;
      if (d >= fromYmd) out.push(d);
    }
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

/** Horários dos lembretes de uma conta: N dias antes às 9h + aviso de vencida no dia seguinte às 9h. */
export function billReminderTimes(dueYmd: string, daysBefore: number[], now: Date): { kind: 'conta' | 'conta_vencida'; at: Date }[] {
  const times: { kind: 'conta' | 'conta_vencida'; at: Date }[] = [...new Set(daysBefore)]
    .map((d) => ({ kind: 'conta' as const, at: spAt(addDays(dueYmd, -d), REMINDER_HOUR) }))
    .filter((t) => t.at > now);
  times.push({ kind: 'conta_vencida', at: spAt(addDays(dueYmd, 1), REMINDER_HOUR) });
  return times.filter((t) => t.at > now).sort((a, b) => +a.at - +b.at);
}

/** Horários dos lembretes de um compromisso (minutos antes), só os que ainda estão no futuro. */
export function eventReminderTimes(startsAt: Date, minutesBefore: number[], now: Date): Date[] {
  return [...new Set(minutesBefore)]
    .map((m) => new Date(startsAt.getTime() - m * 60_000))
    .filter((d) => d > now)
    .sort((a, b) => +a - +b);
}

/** "1 dia", "2 horas", "30 min" */
export function humanOffset(min: number): string {
  if (min % 1440 === 0) return `${min / 1440} dia${min / 1440 > 1 ? 's' : ''}`;
  if (min % 60 === 0) return `${min / 60} hora${min / 60 > 1 ? 's' : ''}`;
  return `${min} min`;
}

function dateLabel(ymd: string, today: string): string {
  if (ymd === today) return 'hoje';
  if (ymd === addDays(today, 1)) return 'amanhã';
  if (ymd === addDays(today, -1)) return 'ontem';
  const d = spAt(ymd, '12:00');
  const wd = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, weekday: 'short' }).format(d).replace('.', '');
  return `${wd}, ${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;
}

const hm = (d: Date) => formatDateTime(d).split(' às ')[1];

// ---------------------------------------------------------------- compromissos

export type EventView = {
  title: string;
  starts_at: Date;
  location?: string | null;
  participants: string[];
  remind_before: number[];
};

export function eventCreatedText(e: EventView, now: Date): string {
  const today = localYmd(now);
  const reminders = eventReminderTimes(e.starts_at, e.remind_before, now);
  return [
    '📅 *Compromisso agendado*',
    `*${e.title}*`,
    `🕐 ${dateLabel(localYmd(e.starts_at), today)} às ${hm(e.starts_at)}`,
    ...(e.location ? [`📍 ${e.location}`] : []),
    `👥 ${e.participants.join(', ')}`,
    reminders.length
      ? `🔔 Aviso ${e.remind_before.filter((m) => e.starts_at.getTime() - m * 60_000 > now.getTime()).sort((a, b) => b - a).map((m) => `${humanOffset(m)} antes`).join(' e ')}`
      : '🔔 Sem aviso (já está muito perto)',
  ].join('\n');
}

export function eventListText(events: EventView[], now: Date, title = 'Agenda'): string {
  if (!events.length) return `📅 *${title}*\nNenhum compromisso. 🙂`;
  const today = localYmd(now);
  const byDay = new Map<string, EventView[]>();
  for (const e of [...events].sort((a, b) => +a.starts_at - +b.starts_at)) {
    const k = localYmd(e.starts_at);
    byDay.set(k, [...(byDay.get(k) ?? []), e]);
  }
  const lines = [`📅 *${title}*`];
  for (const [day, list] of byDay) {
    lines.push('', `*${dateLabel(day, today).replace(/^./, (c) => c.toUpperCase())}*`);
    for (const e of list) lines.push(`• ${hm(e.starts_at)} — ${e.title}${e.location ? ` (${e.location})` : ''}${e.participants.length ? ` · ${e.participants.join(', ')}` : ''}`);
  }
  return lines.join('\n');
}

export function eventReminderText(e: EventView, now: Date): string {
  const mins = Math.round((e.starts_at.getTime() - now.getTime()) / 60_000);
  const when = mins >= 1380 ? `amanhã às ${hm(e.starts_at)}` : mins >= 60 ? `em ${Math.round(mins / 60)} hora${Math.round(mins / 60) > 1 ? 's' : ''} (${hm(e.starts_at)})` : `em ${Math.max(mins, 0)} min (${hm(e.starts_at)})`;
  return [`🔔 *Lembrete:* ${e.title}`, `🕐 ${when}`, ...(e.location ? [`📍 ${e.location}`] : [])].join('\n');
}

// ---------------------------------------------------------------- contas

export type BillView = {
  name: string;
  amount_cents: number | null;
  recurrence: 'mensal' | 'anual' | 'unica';
  due_day: number | null;
  due_month: number | null;
  due_date: string | null;
  remind_days_before: number[];
};

function ruleText(b: BillView): string {
  if (b.recurrence === 'mensal') return `todo dia ${b.due_day}`;
  if (b.recurrence === 'anual') return `todo ano em ${pad(b.due_day ?? 1)}/${pad(b.due_month ?? 1)}`;
  return `em ${b.due_date?.slice(8, 10)}/${b.due_date?.slice(5, 7)}/${b.due_date?.slice(0, 4)}`;
}

export function billCreatedText(b: BillView, nextDue: string | null, now: Date): string {
  const reminders = [...b.remind_days_before].sort((x, y) => y - x).map((d) => (d === 0 ? 'no dia' : `${d} dia${d > 1 ? 's' : ''} antes`));
  return [
    '🧾 *Conta cadastrada*',
    `*${b.name}*${b.amount_cents ? ` — ${formatBRL(b.amount_cents)}` : ''}`,
    `📆 Vence ${ruleText(b)}`,
    ...(nextDue ? [`⏭️ Próximo vencimento: ${dateLabel(nextDue, localYmd(now))}`] : []),
    `🔔 Lembrete ${reminders.join(' e ')}, às 9h`,
  ].join('\n');
}

export type PaymentView = { name: string; amount_cents: number | null; due_date: string; paid_at: Date | null };

export function billListText(items: PaymentView[], now: Date, title: string): string {
  if (!items.length) return `🧾 Nenhuma conta ${title}. 🙂`;
  const today = localYmd(now);
  const sorted = [...items].sort((a, b) => a.due_date.localeCompare(b.due_date));
  const open = sorted.filter((p) => !p.paid_at);
  const total = open.reduce((s, p) => s + (p.amount_cents ?? 0), 0);
  const lines = [`🧾 *Contas ${title}*`];
  for (const p of sorted) {
    const icon = p.paid_at ? '✅' : p.due_date < today ? '🔴' : p.due_date <= addDays(today, 3) ? '🟡' : '⚪';
    const status = p.paid_at ? 'paga' : p.due_date < today ? 'VENCIDA' : dateLabel(p.due_date, today);
    lines.push(`${icon} ${p.name}${p.amount_cents ? ` — ${formatBRL(p.amount_cents)}` : ''} · ${status}`);
  }
  if (open.length) lines.push('', `A pagar: ${open.length} ${open.length > 1 ? 'contas' : 'conta'}${total ? ` · ${formatBRL(total)}` : ''}`);
  return lines.join('\n');
}

export function billReminderText(p: PaymentView, kind: 'conta' | 'conta_vencida', now: Date): string {
  const today = localYmd(now);
  const value = p.amount_cents ? ` — ${formatBRL(p.amount_cents)}` : '';
  if (kind === 'conta_vencida') {
    return `🔴 *Conta vencida:* ${p.name}${value}\nVenceu ${dateLabel(p.due_date, today)}. Já pagou? Me avise: _"paguei ${p.name.toLowerCase()}"_.`;
  }
  const label = dateLabel(p.due_date, today);
  return `🧾 *Conta vence ${label}:* ${p.name}${value}\nQuando pagar, me avise: _"paguei ${p.name.toLowerCase()}"_.`;
}
