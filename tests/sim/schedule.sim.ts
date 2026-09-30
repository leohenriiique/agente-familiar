/**
 * Fase 4 de ponta a ponta: conversa → banco → agendador → WhatsApp.
 * As datas são relativas ao "agora" real, e o agendador é chamado com horários simulados.
 */
import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { claudeRequests, fakeDb, respond, say, sent, state, tables, toolUse } from './harness.js';

Object.assign(process.env, {
  WEBHOOK_TOKEN: 'token-de-teste-1234567',
  EVOLUTION_URL: 'http://evolution.test',
  EVOLUTION_API_KEY: 'k',
  EVOLUTION_INSTANCE: 'agente-familiar',
  SUPABASE_URL: 'http://supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'k',
  ANTHROPIC_API_KEY: 'sk-ant-teste',
  OPENAI_API_KEY: 'sk-teste',
});
mock.module(new URL('../../src/db/supabase.ts', import.meta.url).href, { namedExports: { db: fakeDb } });
const { handleIncoming } = await import('../../src/handlers/incoming.js');
const { parseEvolutionWebhook } = await import('../../src/whatsapp/parse.js');
const { dispatchDueReminders, refreshAllBills } = await import('../../src/scheduler.js');
const { localIso } = await import('../../src/agent/format.js');
const { addDays, localYmd, spAt } = await import('../../src/agent/schedule-format.js');

const FAMILY = 'fam-1';
const LEO_PHONE = '5534999999999';
const ANA_PHONE = '5534988887777';

let n = 0;
const webhook = (message: Record<string, unknown>) =>
  parseEvolutionWebhook({
    event: 'messages.upsert',
    data: { key: { remoteJid: `${LEO_PHONE}@s.whatsapp.net`, fromMe: false, id: `SCH${++n}` }, message, messageTimestamp: Math.floor(Date.now() / 1000) },
  })!;
const lastSent = () => sent.at(-1)!.text;
const reminders = () => tables.reminders ?? [];

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  tables.members = [
    { id: 'mem-leo', family_id: FAMILY, name: 'Leo', phone: LEO_PHONE, role: 'admin', active: true },
    { id: 'mem-ana', family_id: FAMILY, name: 'Ana', phone: ANA_PHONE, role: 'membro', active: true },
  ];
  tables.categories = [
    { id: 'cat-contas', family_id: FAMILY, name: 'Contas da casa', emoji: '💡' },
    { id: 'cat-outros', family_id: FAMILY, name: 'Outros', emoji: '📦' },
  ];
  state.claudeQueue = [];
  claudeRequests.length = 0;
  sent.length = 0;
});

// ---------------------------------------------------------------- agenda

test('compromisso: cria, agenda avisos para cada participante e o agendador envia na hora', async () => {
  const start = new Date(Date.now() + 3 * 24 * 3600 * 1000);
  start.setUTCMinutes(0, 0, 0);
  state.claudeQueue = [
    toolUse('criar_compromisso', { titulo: 'Dentista da Ana', inicio: localIso(start), local: 'Clínica Sorriso', participantes: ['Ana'] }),
    say('OK'),
  ];
  await handleIncoming(webhook({ conversation: 'dentista da Ana daqui 3 dias' }));

  const ev = tables.events![0]!;
  assert.equal(ev.title, 'Dentista da Ana');
  assert.equal(ev.starts_at, start.toISOString());
  assert.deepEqual([...ev.participants].sort(), ['mem-ana', 'mem-leo']); // quem pediu entra sempre
  assert.match(lastSent(), /Compromisso agendado/);
  assert.match(lastSent(), /👥 Leo, Ana|👥 Ana, Leo/);
  assert.match(lastSent(), /🔔 Aviso 1 dia antes e 1 hora antes/);

  // 2 horários × 2 pessoas
  assert.equal(reminders().length, 4);
  const oneDayBefore = new Date(start.getTime() - 24 * 3600 * 1000);

  sent.length = 0;
  assert.equal(await dispatchDueReminders(new Date(oneDayBefore.getTime() - 60_000)), 0); // ainda não
  assert.equal(await dispatchDueReminders(new Date(oneDayBefore.getTime() + 30_000)), 2);
  assert.deepEqual(sent.map((s) => s.number).sort(), [ANA_PHONE, LEO_PHONE]);
  assert.match(sent[0]!.text, /🔔 \*Lembrete:\* Dentista da Ana/);
  assert.match(sent[0]!.text, /amanhã às/);
  // não reenvia
  assert.equal(await dispatchDueReminders(new Date(oneDayBefore.getTime() + 90_000)), 0);
});

test('compromisso: mudar o horário refaz os avisos; cancelar apaga os pendentes', async () => {
  const start = new Date(Date.now() + 5 * 24 * 3600 * 1000);
  start.setUTCMinutes(0, 0, 0);
  state.claudeQueue = [toolUse('criar_compromisso', { titulo: 'Reunião da escola', inicio: localIso(start) }), say('OK')];
  await handleIncoming(webhook({ conversation: 'reunião da escola' }));
  assert.equal(reminders().length, 2);

  const later = new Date(start.getTime() + 2 * 3600 * 1000);
  state.claudeQueue = [toolUse('editar_compromisso', { inicio: localIso(later) }), say('OK')];
  await handleIncoming(webhook({ conversation: 'passou 2 horas mais tarde' }));
  assert.match(lastSent(), /Compromisso atualizado/);
  assert.equal(reminders().length, 2);
  assert.ok(reminders().every((r) => new Date(r.send_at) >= new Date(later.getTime() - 24 * 3600 * 1000)));

  state.claudeQueue = [
    toolUse('cancelar_compromisso', { confirmado_pelo_usuario: false }),
    (body) => {
      assert.match(body.messages.at(-1).content[0].content, /Cancelo Reunião da escola/);
      return respond('Cancelo a Reunião da escola?')();
    },
  ];
  await handleIncoming(webhook({ conversation: 'cancela a reunião' }));
  assert.equal(tables.events!.length, 1);

  state.claudeQueue = [toolUse('cancelar_compromisso', { confirmado_pelo_usuario: true }), say('OK')];
  await handleIncoming(webhook({ conversation: 'sim' }));
  assert.equal(tables.events!.length, 0);
  assert.equal(reminders().length, 0);
});

test('compromisso sem hora é recusado pela ferramenta (o agente pergunta)', async () => {
  state.claudeQueue = [
    toolUse('criar_compromisso', { titulo: 'Médico', inicio: addDays(localYmd(new Date()), 2) }),
    (body) => {
      assert.match(body.messages.at(-1).content[0].content, /Pergunte o horário/);
      return say('Que horas é o médico?')();
    },
  ];
  await handleIncoming(webhook({ conversation: 'médico depois de amanhã' }));
  assert.equal(tables.events?.length ?? 0, 0);
  assert.equal(lastSent(), 'Que horas é o médico?');
});

test('"o que temos amanhã?" lista do banco', async () => {
  const tomorrow = addDays(localYmd(new Date()), 1);
  tables.events = [
    { id: 'e1', family_id: FAMILY, created_by: 'mem-leo', title: 'Futebol', starts_at: spAt(tomorrow, '18:00').toISOString(), location: null, participants: ['mem-leo'], remind_before: [60] },
    { id: 'e2', family_id: FAMILY, created_by: 'mem-ana', title: 'Pediatra', starts_at: spAt(tomorrow, '09:30').toISOString(), location: 'Posto', participants: ['mem-ana'], remind_before: [60] },
    { id: 'e3', family_id: FAMILY, created_by: 'mem-leo', title: 'Longe', starts_at: spAt(addDays(tomorrow, 3), '10:00').toISOString(), location: null, participants: [], remind_before: [] },
  ];
  state.claudeQueue = [toolUse('listar_compromissos', { de: tomorrow, ate: tomorrow }), say('OK')];
  await handleIncoming(webhook({ conversation: 'o que temos amanhã?' }));
  const txt = lastSent();
  assert.match(txt, /Agenda de amanhã/);
  assert.ok(txt.indexOf('09:30 — Pediatra (Posto) · Ana') < txt.indexOf('18:00 — Futebol · Leo'));
  assert.doesNotMatch(txt, /Longe/);
});

// ---------------------------------------------------------------- contas

test('conta: cadastra, lembra antes, pagar lança gasto e cancela os próximos avisos', async () => {
  const due = addDays(localYmd(new Date()), 5);
  const day = Number(due.slice(8, 10));
  state.claudeQueue = [toolUse('cadastrar_conta', { nome: 'internet', valor: 120, recorrencia: 'mensal', dia_vencimento: day }), say('OK')];
  await handleIncoming(webhook({ conversation: `internet vence todo dia ${day}, 120 reais` }));

  assert.equal(tables.bills![0]!.name, 'Internet');
  assert.match(lastSent(), /Conta cadastrada/);
  assert.match(lastSent(), /Internet\* — R\$ 120,00/);
  assert.match(lastSent(), new RegExp(`todo dia ${day}`));
  const pay = tables.bill_payments!.find((p) => p.due_date === due)!;
  assert.ok(pay);
  // só o admin (Leo, que também cadastrou) recebe: 3 dias antes, no dia e vencida
  const rs = reminders().filter((r) => r.ref_id === pay.id);
  assert.deepEqual(rs.map((r) => r.kind).sort(), ['conta', 'conta', 'conta_vencida']);
  assert.ok(rs.every((r) => r.target_member_id === 'mem-leo'));

  // idempotente: rodar o gerador de contas de novo não duplica
  await refreshAllBills();
  assert.equal(tables.bill_payments!.filter((p) => p.due_date === due).length, 1);
  assert.equal(reminders().filter((r) => r.ref_id === pay.id).length, 3);

  // 3 dias antes, às 9h
  sent.length = 0;
  await dispatchDueReminders(new Date(spAt(addDays(due, -3), '09:00').getTime() + 30_000));
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /🧾 \*Conta vence .*:\* Internet — R\$ 120,00/);

  // paga: vira gasto em "Contas da casa" e os avisos restantes somem
  state.claudeQueue = [toolUse('pagar_conta', { conta: 'internet' }), say('OK')];
  await handleIncoming(webhook({ conversation: 'paguei a internet' }));
  assert.ok(tables.bill_payments!.find((p) => p.id === pay.id)!.paid_at);
  assert.equal(tables.expenses![0]!.amount_cents, 12000);
  assert.equal(tables.expenses![0]!.category_id, 'cat-contas');
  assert.equal(tables.bill_payments!.find((p) => p.id === pay.id)!.expense_id, tables.expenses![0]!.id);
  assert.match(lastSent(), /✅ \*Internet\* paga/);
  assert.match(lastSent(), /Gasto registrado/);
  assert.equal(reminders().filter((r) => r.ref_id === pay.id && !r.sent_at).length, 0);

  sent.length = 0;
  await dispatchDueReminders(new Date(spAt(addDays(due, 1), '09:00').getTime() + 30_000));
  assert.equal(sent.length, 0); // sem aviso de vencida
});

test('conta: não paga gera aviso de vencida no dia seguinte', async () => {
  const due = addDays(localYmd(new Date()), 2);
  state.claudeQueue = [toolUse('cadastrar_conta', { nome: 'Luz', recorrencia: 'unica', data_vencimento: due }), say('OK')];
  await handleIncoming(webhook({ conversation: `luz vence ${due}` }));
  sent.length = 0;
  await dispatchDueReminders(new Date(spAt(addDays(due, 1), '09:00').getTime() + 30_000));
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /🔴 \*Conta vencida:\* Luz/);
  assert.match(sent[0]!.text, /Venceu ontem/);
});

test('conta: pagar sem valor conhecido não lança gasto e explica', async () => {
  const due = addDays(localYmd(new Date()), 4);
  state.claudeQueue = [toolUse('cadastrar_conta', { nome: 'Água', recorrencia: 'mensal', dia_vencimento: Number(due.slice(8, 10)) }), say('OK')];
  await handleIncoming(webhook({ conversation: 'água vence todo mês' }));
  state.claudeQueue = [toolUse('pagar_conta', { conta: 'a água' }), say('OK')];
  await handleIncoming(webhook({ conversation: 'paguei a água' }));
  assert.equal(tables.expenses?.length ?? 0, 0);
  assert.match(lastSent(), /Água\* paga/);
  assert.match(lastSent(), /não sei o valor/);
});

test('conta: lista do mês com status', async () => {
  const today = localYmd(new Date());
  const due = addDays(today, 3);
  state.claudeQueue = [toolUse('cadastrar_conta', { nome: 'Internet', valor: 120, recorrencia: 'unica', data_vencimento: due }), say('OK')];
  await handleIncoming(webhook({ conversation: 'internet' }));
  state.claudeQueue = [toolUse('listar_contas', {}), say('OK')];
  await handleIncoming(webhook({ conversation: 'quais contas vencem?' }));
  assert.match(lastSent(), /Contas dos próximos 30 dias/);
  assert.match(lastSent(), /🟡 Internet — R\$ 120,00/);
  assert.match(lastSent(), /A pagar: 1 conta · R\$ 120,00/);
});

// ---------------------------------------------------------------- agendador

test('agendador: lembrete muito atrasado (servidor fora do ar) é descartado, não enviado', async () => {
  tables.events = [{ id: 'ev', family_id: FAMILY, created_by: 'mem-leo', title: 'X', starts_at: new Date(Date.now() + 86400000).toISOString(), location: null, participants: ['mem-leo'], remind_before: [60] }];
  tables.reminders = [{ id: 'r1', family_id: FAMILY, target_member_id: 'mem-leo', kind: 'evento', ref_id: 'ev', send_at: new Date(Date.now() - 7 * 3600 * 1000).toISOString(), sent_at: null, payload: null }];
  assert.equal(await dispatchDueReminders(new Date()), 0);
  assert.equal(sent.length, 0);
  assert.equal(tables.reminders[0]!.payload.skipped, 'atrasado demais');
});

test('agendador: falha no WhatsApp devolve o lembrete para a fila', async () => {
  tables.events = [{ id: 'ev', family_id: FAMILY, created_by: 'mem-leo', title: 'X', starts_at: new Date(Date.now() + 86400000).toISOString(), location: null, participants: ['mem-leo'], remind_before: [60] }];
  tables.reminders = [{ id: 'r1', family_id: FAMILY, target_member_id: 'mem-leo', kind: 'evento', ref_id: 'ev', send_at: new Date(Date.now() - 60_000).toISOString(), sent_at: null, payload: null }];
  tables.members![0]!.phone = 'FALHA';
  state.failSendTo = 'FALHA';
  assert.equal(await dispatchDueReminders(new Date()), 0);
  assert.equal(tables.reminders[0]!.sent_at, null);
  assert.equal(tables.reminders[0]!.payload.attempts, 1);
  state.failSendTo = '';
});
