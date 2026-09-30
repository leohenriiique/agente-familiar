import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addDays, billListText, billReminderText, billReminderTimes, dueDatesBetween, dueInMonth, eventCreatedText,
  eventReminderText, eventReminderTimes, humanOffset, localYmd, spAt,
} from '../src/agent/schedule-format.js';

test('vencimento no fim do mês', () => {
  assert.equal(dueInMonth(2026, 2, 31), '2026-02-28');
  assert.equal(dueInMonth(2028, 2, 30), '2028-02-29'); // bissexto
  assert.equal(dueInMonth(2026, 4, 31), '2026-04-30');
  assert.equal(dueInMonth(2026, 10, 15), '2026-10-15');
});

test('ocorrências de conta mensal nos próximos 40 dias', () => {
  const rule = { recurrence: 'mensal' as const, due_day: 15, due_month: null, due_date: null };
  assert.deepEqual(dueDatesBetween(rule, '2026-09-30'), ['2026-10-15']);
  assert.deepEqual(dueDatesBetween({ ...rule, due_day: 30 }, '2026-09-30'), ['2026-09-30', '2026-10-30']);
  // cadastrada dia 20 com vencimento dia 15: este mês já passou, começa no próximo
  assert.deepEqual(dueDatesBetween(rule, '2026-09-20'), ['2026-10-15']);
  // virada de ano
  assert.deepEqual(dueDatesBetween({ ...rule, due_day: 5 }, '2026-12-10'), ['2027-01-05']);
});

test('ocorrências de conta anual e única', () => {
  const anual = { recurrence: 'anual' as const, due_day: 20, due_month: 10, due_date: null };
  assert.deepEqual(dueDatesBetween(anual, '2026-09-30'), ['2026-10-20']);
  assert.deepEqual(dueDatesBetween({ ...anual, due_month: 3 }, '2026-09-30'), []); // longe demais
  const unica = { recurrence: 'unica' as const, due_day: null, due_month: null, due_date: '2026-10-05' };
  assert.deepEqual(dueDatesBetween(unica, '2026-09-30'), ['2026-10-05']);
  assert.deepEqual(dueDatesBetween(unica, '2026-10-06'), []);
});

test('lembretes de conta: 3 dias antes e no dia às 9h + vencida no dia seguinte', () => {
  const now = spAt('2026-09-30', '10:00');
  const t = billReminderTimes('2026-10-15', [3, 0], now);
  assert.deepEqual(t.map((x) => [x.kind, x.at.toISOString()]), [
    ['conta', '2026-10-12T12:00:00.000Z'],
    ['conta', '2026-10-15T12:00:00.000Z'],
    ['conta_vencida', '2026-10-16T12:00:00.000Z'],
  ]);
  // horários que já passaram não entram
  const late = billReminderTimes('2026-10-01', [3, 0], now);
  assert.deepEqual(late.map((x) => x.at.toISOString()), ['2026-10-01T12:00:00.000Z', '2026-10-02T12:00:00.000Z']);
});

test('lembretes de compromisso: só os que ainda estão no futuro', () => {
  const start = spAt('2026-10-01', '14:00');
  assert.deepEqual(eventReminderTimes(start, [1440, 60], spAt('2026-09-30', '10:00')).map((d) => d.toISOString()), [
    '2026-09-30T17:00:00.000Z', '2026-10-01T16:00:00.000Z',
  ]);
  assert.deepEqual(eventReminderTimes(start, [1440, 60], spAt('2026-09-30', '20:00')).map((d) => d.toISOString()), ['2026-10-01T16:00:00.000Z']);
  assert.equal(humanOffset(1440), '1 dia');
  assert.equal(humanOffset(120), '2 horas');
  assert.equal(humanOffset(30), '30 min');
});

test('textos de compromisso', () => {
  const now = spAt('2026-09-30', '10:00');
  const ev = { title: 'Dentista da Ana', starts_at: spAt('2026-10-01', '14:00'), location: 'Clínica Sorriso', participants: ['Leo', 'Ana'], remind_before: [1440, 60] };
  const c = eventCreatedText(ev, now);
  assert.match(c, /Compromisso agendado/);
  assert.match(c, /🕐 amanhã às 14:00/);
  assert.match(c, /📍 Clínica Sorriso/);
  assert.match(c, /👥 Leo, Ana/);
  assert.match(c, /🔔 Aviso 1 dia antes e 1 hora antes/);
  assert.match(eventReminderText(ev, spAt('2026-10-01', '13:00')), /em 1 hora \(14:00\)/);
  assert.match(eventReminderText(ev, spAt('2026-09-30', '14:00')), /amanhã às 14:00/);
});

test('textos de conta', () => {
  const now = spAt('2026-10-13', '09:00');
  const p = { name: 'Internet', amount_cents: 12000, due_date: '2026-10-15', paid_at: null };
  assert.match(billReminderText(p, 'conta', now), /Conta vence qui, 15\/10:\* Internet — R\$ 120,00/);
  assert.match(billReminderText({ ...p, due_date: '2026-10-13' }, 'conta', now), /Conta vence hoje/);
  assert.match(billReminderText({ ...p, due_date: '2026-10-12' }, 'conta_vencida', now), /Conta vencida.*\n.*Venceu ontem/);
  const list = billListText([
    p,
    { name: 'Luz', amount_cents: 18700, due_date: '2026-10-10', paid_at: null },
    { name: 'Aluguel', amount_cents: 150000, due_date: '2026-10-05', paid_at: new Date() },
  ], now, 'deste mês');
  assert.match(list, /✅ Aluguel — R\$ 1\.500,00 · paga/);
  assert.match(list, /🔴 Luz — R\$ 187,00 · VENCIDA/);
  assert.match(list, /🟡 Internet — R\$ 120,00 · qui, 15\/10/);
  assert.match(list, /A pagar: 2 contas · R\$ 307,00/);
});

test('datas locais', () => {
  assert.equal(localYmd(new Date('2026-10-01T02:30:00Z')), '2026-09-30'); // 23:30 em SP
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
});
