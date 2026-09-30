/**
 * Simulação de ponta a ponta da fase 2, sem serviços reais:
 * - banco: um Supabase falso em memória (mock do módulo db)
 * - Claude, OpenAI e Evolution: fetch falso com respostas roteirizadas
 *
 *   npm run test:sim
 */
import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { claudeRequests, fakeDb, say, sent, state, tables, toolUse, uploads, type ClaudeScript } from './harness.js';

// ---------------------------------------------------------------- app sob teste
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

const FAMILY = 'fam-1';
const LEO = { id: 'mem-leo', family_id: FAMILY, name: 'Leo', phone: '5534999999999', role: 'admin', active: true, created_at: '2026-01-01' };
const CATS = ['Mercado', 'Combustível', 'Saúde', 'Alimentação fora', 'Outros'].map((name, i) => ({
  id: `cat-${i}`, family_id: FAMILY, name, emoji: ['🛒', '⛽', '💊', '🍔', '📦'][i],
}));

let n = 0;
function webhook(message: Record<string, unknown>, ts = '2026-09-30T14:00:00Z') {
  return parseEvolutionWebhook({
    event: 'messages.upsert',
    data: {
      key: { remoteJid: '5534999999999@s.whatsapp.net', fromMe: false, id: `IN${++n}` },
      message,
      messageTimestamp: Math.floor(Date.parse(ts) / 1000),
    },
  })!;
}
const lastSent = () => sent.at(-1)!.text;
const expenses = () => tables.expenses ?? [];

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  tables.members = [{ ...LEO }];
  tables.categories = CATS.map((c) => ({ ...c }));
  state.claudeQueue = [];
  claudeRequests.length = 0;
  sent.length = 0;
  uploads.length = 0;
});

// ---------------------------------------------------------------- cenários

test('texto: registra gasto com data relativa e confirma com categoria, data e valor', async () => {
  state.claudeQueue = [
    toolUse('registrar_gasto', { valor: 50, categoria: 'Combustível', descricao: 'gasolina', data_hora: '2026-09-29' }),
    say('OK'),
  ];
  await handleIncoming(webhook({ conversation: 'gastei 50 de gasolina ontem' }));

  assert.equal(expenses().length, 1);
  const e = expenses()[0]!;
  assert.equal(e.amount_cents, 5000);
  assert.equal(e.category_id, 'cat-1');
  assert.equal(e.status, 'confirmado');
  assert.equal(e.source, 'texto');
  assert.equal(e.spent_at, '2026-09-29T15:00:00.000Z'); // meio-dia em SP
  const reply = lastSent();
  assert.match(reply, /Gasto registrado/);
  assert.match(reply, /R\$ 50,00/);
  assert.match(reply, /⛽ Combustível — gasolina/);
  assert.match(reply, /29\/09\/2026 às 12:00/);
  assert.doesNotMatch(reply, /\bOK\b/); // o "OK" do modelo não vai para a pessoa

  // o Claude recebeu as categorias da família e a data de hoje
  const req = claudeRequests[0];
  assert.deepEqual([...req.tools[0].input_schema.properties.categoria.enum].sort(), CATS.map((c) => c.name).sort());
  assert.match(req.system, /Está falando com Leo/);
});

test('texto: sem gasto só conversa (sem ferramenta) e a resposta do modelo é enviada', async () => {
  state.claudeQueue = [say('Quanto foi a gasolina?')];
  await handleIncoming(webhook({ conversation: 'abasteci o carro' }));
  assert.equal(expenses().length, 0);
  assert.equal(lastSent(), 'Quanto foi a gasolina?');
});

test('correção: "na verdade foi 45" atualiza o último gasto', async () => {
  state.claudeQueue = [toolUse('registrar_gasto', { valor: 50, categoria: 'Combustível', descricao: 'gasolina' }), say('OK')];
  await handleIncoming(webhook({ conversation: 'gastei 50 de gasolina' }));

  state.claudeQueue = [toolUse('corrigir_gasto', { valor: 45 }), say('OK')];
  await handleIncoming(webhook({ conversation: 'na verdade foi 45' }));

  assert.equal(expenses().length, 1);
  assert.equal(expenses()[0]!.amount_cents, 4500);
  assert.match(lastSent(), /Gasto atualizado/);
  assert.match(lastSent(), /R\$ 45,00/);
  // o histórico da conversa e o gasto recente foram mandados como contexto
  const ctx = claudeRequests.at(-2).messages[0].content[0].text as string;
  assert.match(ctx, /Conversa recente:/);
  assert.match(ctx, /Leo: gastei 50 de gasolina/);
  assert.match(ctx, /Gastos recentes de Leo/);
  assert.match(ctx, /R\$ 50,00 \| Combustível/);
});

test('foto de cupom com leitura incerta: fica pendente, guarda o arquivo e confirma com "sim"', async () => {
  state.claudeQueue = [
    toolUse('registrar_gasto', {
      valor: 187.4, categoria: 'Mercado', descricao: 'compras', estabelecimento: 'Supermercado Bretas',
      data_hora: '2026-09-29T18:42', forma_pagamento: 'Débito', precisa_confirmar: true,
    }),
    say('A foto estava um pouco borrada no total.'),
  ];
  const img = webhook({ imageMessage: { caption: 'mercado', mimetype: 'image/jpeg' }, base64: Buffer.from('jpeg').toString('base64') });
  await handleIncoming(img);

  const e = expenses()[0]!;
  assert.equal(e.status, 'pendente');
  assert.equal(e.source, 'imagem');
  assert.equal(e.receipt_path, `${FAMILY}/imagem/${img.waMessageId}.jpg`);
  assert.deepEqual(uploads, [e.receipt_path]);
  assert.match(lastSent(), /Confere antes de eu salvar/);
  assert.match(lastSent(), /R\$ 187,40/);
  assert.match(lastSent(), /borrada/); // observação do modelo vai junto

  // a imagem foi de fato enviada ao Claude, com a legenda
  const content = claudeRequests[0].messages[0].content;
  assert.ok(content.some((b: any) => b.type === 'image' && b.source.media_type === 'image/jpeg'));
  assert.ok(content.some((b: any) => b.type === 'text' && /Legenda da foto: mercado/.test(b.text)));

  state.claudeQueue = [toolUse('confirmar_gasto', {}), say('OK')];
  await handleIncoming(webhook({ conversation: 'sim' }));
  assert.equal(expenses()[0]!.status, 'confirmado');
  assert.match(lastSent(), /Gasto registrado/);
});

test('foto sem base64 no webhook: baixa pela Evolution', async () => {
  state.claudeQueue = [toolUse('registrar_gasto', { valor: 12, categoria: 'Alimentação fora', descricao: 'café' }), say('OK')];
  await handleIncoming(webhook({ imageMessage: { mimetype: 'image/jpeg' } }));
  assert.equal(expenses()[0]!.amount_cents, 1200);
});

test('áudio: transcreve, mostra o que entendeu e registra', async () => {
  state.transcription = 'gastei 30 reais na padaria';
  state.claudeQueue = [toolUse('registrar_gasto', { valor: 30, categoria: 'Alimentação fora', descricao: 'padaria' }), say('OK')];
  const aud = webhook({ audioMessage: { mimetype: 'audio/ogg; codecs=opus' }, base64: Buffer.from('ogg').toString('base64') });
  await handleIncoming(aud);

  assert.equal(expenses()[0]!.source, 'audio');
  assert.match(lastSent(), /^🎙️ _"gastei 30 reais na padaria"_/);
  assert.match(lastSent(), /Gasto registrado/);
  const logged = tables.messages!.find((m) => m.wa_message_id === aud.waMessageId)!;
  assert.equal(logged.text, 'gastei 30 reais na padaria');
  assert.equal(logged.media_path, `${FAMILY}/audio/${aud.waMessageId}.ogg`);
  // o Claude recebeu como áudio transcrito
  assert.match(JSON.stringify(claudeRequests[0].messages[0].content), /Áudio transcrito: gastei 30 reais na padaria/);
});

test('áudio sem fala: pede para repetir e não chama o Claude', async () => {
  state.transcription = '';
  await handleIncoming(webhook({ audioMessage: { mimetype: 'audio/ogg' }, base64: 'AAAA' }));
  assert.equal(claudeRequests.length, 0);
  assert.match(lastSent(), /Não consegui entender o áudio/);
});

test('excluir: sem confirmação não apaga; com confirmação apaga', async () => {
  state.claudeQueue = [toolUse('registrar_gasto', { valor: 20, categoria: 'Outros', descricao: 'teste' }), say('OK')];
  await handleIncoming(webhook({ conversation: 'gastei 20 num teste' }));

  state.claudeQueue = [
    toolUse('excluir_gasto', { confirmado_pelo_usuario: false }),
    (body) => {
      // o resultado da ferramenta chegou como erro, com a pergunta sugerida
      const res = body.messages.at(-1).content[0];
      assert.equal(res.is_error, true);
      assert.match(res.content, /Posso apagar o gasto de R\$ 20,00/);
      return say('Posso apagar o gasto de R$ 20,00 (teste)?')();
    },
  ];
  await handleIncoming(webhook({ conversation: 'apaga o último gasto' }));
  assert.equal(expenses().length, 1);
  assert.match(lastSent(), /Posso apagar/);

  state.claudeQueue = [toolUse('excluir_gasto', { confirmado_pelo_usuario: true }), say('OK')];
  await handleIncoming(webhook({ conversation: 'sim' }));
  assert.equal(expenses().length, 0);
  assert.match(lastSent(), /apagado/);
});

test('duas compras numa mensagem viram dois gastos', async () => {
  state.claudeQueue = [
    () => ({
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'a', name: 'registrar_gasto', input: { valor: 50, categoria: 'Combustível', descricao: 'gasolina' } },
        { type: 'tool_use', id: 'b', name: 'registrar_gasto', input: { valor: 30, categoria: 'Alimentação fora', descricao: 'padaria' } },
      ],
    }),
    say('OK'),
  ];
  await handleIncoming(webhook({ conversation: '50 de gasolina e 30 na padaria' }));
  assert.equal(expenses().length, 2);
  assert.equal((lastSent().match(/Gasto registrado/g) ?? []).length, 2);
});

test('gasto de outro membro/família não pode ser alterado por id', async () => {
  tables.expenses = [{
    id: '11111111-1111-4111-8111-111111111111', family_id: 'outra-familia', member_id: 'x', category_id: null,
    amount_cents: 999, description: 'alheio', merchant: null, spent_at: '2026-09-01T12:00:00Z', payment_method: null,
    status: 'confirmado', created_at: '2026-09-01',
  }];
  state.claudeQueue = [toolUse('corrigir_gasto', { gasto_id: '11111111-1111-4111-8111-111111111111', valor: 1 }), say('Não encontrei esse gasto.')];
  await handleIncoming(webhook({ conversation: 'muda o gasto 1111 para 1 real' }));
  assert.equal(tables.expenses[0]!.amount_cents, 999);
});

test('comandos fixos continuam sem passar pelo Claude', async () => {
  await handleIncoming(webhook({ conversation: 'oi' }));
  await handleIncoming(webhook({ conversation: 'membros' }));
  assert.equal(claudeRequests.length, 0);
  assert.match(sent[0]!.text, /Oi, Leo/);
  assert.match(sent[1]!.text, /Membros da família/);
});

test('erro na API do Claude: pede desculpa e não trava', async () => {
  state.claudeQueue = [() => { throw new Error('boom'); }];
  await handleIncoming(webhook({ conversation: 'gastei 10 no café' }));
  assert.match(lastSent(), /Tive um problema/);
});
