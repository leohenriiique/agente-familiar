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
  assert.deepEqual([...req.tools.find((t: any) => t.name === 'registrar_gasto').input_schema.properties.categoria.enum].sort(), CATS.map((c) => c.name).sort());
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

// ---------------------------------------------------------------- fase 3: lista de compras

test('lista: anota itens por local e seção, sem duplicar', async () => {
  state.claudeQueue = [
    toolUse('adicionar_compras', { itens: [
      { item: 'macarrão', local: 'supermercado', secao: 'mercearia' },
      { item: 'detergente', local: 'supermercado', secao: 'limpeza' },
      { item: 'dipirona', local: 'farmácia' },
    ] }),
    say('OK'),
  ];
  await handleIncoming(webhook({ conversation: 'precisa comprar macarrão, detergente e dipirona' }));
  const items = tables.shopping_items!;
  assert.equal(items.length, 3);
  assert.equal(items.find((i) => i.item === 'dipirona')!.store_type, 'farmácia');
  assert.equal(items.find((i) => i.item === 'macarrão')!.section, 'mercearia');
  assert.equal(items[0]!.added_by, 'mem-leo');
  assert.match(lastSent(), /Anotado na lista/);
  assert.match(lastSent(), /🛒 Supermercado: macarrão, detergente/);
  assert.match(lastSent(), /💊 Farmácia: dipirona/);

  // de novo o macarrão, agora com quantidade: atualiza, não duplica
  state.claudeQueue = [toolUse('adicionar_compras', { itens: [{ item: 'macarrão', quantidade: '2 pacotes', local: 'supermercado', secao: 'mercearia' }] }), say('OK')];
  await handleIncoming(webhook({ conversation: 'anota 2 pacotes de macarrão' }));
  assert.equal(tables.shopping_items!.length, 3);
  assert.equal(tables.shopping_items!.find((i) => i.item === 'macarrão')!.quantity, '2 pacotes');
  assert.match(lastSent(), /já estava na lista/);

  // a lista em aberto foi para o contexto do Claude
  assert.match(JSON.stringify(claudeRequests.at(-2).messages[0].content), /Lista de compras em aberto \(3 itens\)/);
});

test('lista: "estou no supermercado" mostra só o supermercado, por seção, com quem anotou', async () => {
  tables.members!.push({ id: 'mem-ana', family_id: FAMILY, name: 'Ana', phone: '5534988887777', role: 'membro', active: true });
  tables.shopping_items = [
    { id: 's1', family_id: FAMILY, added_by: 'mem-leo', item: 'macarrão', quantity: null, store_type: 'supermercado', section: 'mercearia', bought_at: null, created_at: '1' },
    { id: 's2', family_id: FAMILY, added_by: 'mem-ana', item: 'detergente', quantity: null, store_type: 'supermercado', section: 'limpeza', bought_at: null, created_at: '2' },
    { id: 's3', family_id: FAMILY, added_by: 'mem-ana', item: 'dipirona', quantity: null, store_type: 'farmácia', section: null, bought_at: null, created_at: '3' },
    { id: 's4', family_id: FAMILY, added_by: 'mem-leo', item: 'arroz', quantity: null, store_type: 'supermercado', section: 'mercearia', bought_at: '2026-09-01', created_at: '0' },
    { id: 's5', family_id: 'outra', added_by: 'x', item: 'segredo', quantity: null, store_type: 'supermercado', section: null, bought_at: null, created_at: '4' },
  ];
  state.claudeQueue = [toolUse('consultar_compras', { local: 'supermercado' }), say('OK')];
  await handleIncoming(webhook({ conversation: 'estou no supermercado, precisa comprar algo?' }));
  const reply = lastSent();
  assert.match(reply, /🛒 \*Supermercado\* — 2 itens/);
  assert.match(reply, /\*Mercearia:\* macarrão/);
  assert.match(reply, /\*Limpeza:\* detergente/);
  assert.match(reply, /Anotado por: Leo, Ana/);
  assert.doesNotMatch(reply, /dipirona/); // outro local
  assert.doesNotMatch(reply, /arroz/);    // já comprado
  assert.doesNotMatch(reply, /segredo/);  // outra família
});

test('lista: dar baixa em itens e "comprei tudo" só com confirmação', async () => {
  tables.shopping_items = ['macarrão', 'detergente', 'tomate'].map((item, i) => ({
    id: `s${i}`, family_id: FAMILY, added_by: 'mem-leo', item, quantity: null, store_type: 'supermercado', section: null, bought_at: null, created_at: String(i),
  }));
  state.claudeQueue = [toolUse('marcar_comprado', { itens: ['macarrao', 'feijão'] }), say('OK')];
  await handleIncoming(webhook({ conversation: 'peguei o macarrao e o feijão' }));
  assert.ok(tables.shopping_items.find((i) => i.item === 'macarrão')!.bought_at);
  assert.equal(tables.shopping_items.find((i) => i.item === 'macarrão')!.bought_by, 'mem-leo');
  assert.match(lastSent(), /✅ Comprado: macarrão/);
  assert.match(lastSent(), /Não achei na lista: feijão/);
  assert.match(lastSent(), /Ainda faltam 2 itens/);

  state.claudeQueue = [
    toolUse('marcar_comprado', { tudo: true, local: 'supermercado' }),
    (body) => {
      assert.match(body.messages.at(-1).content[0].content, /Dou baixa em todos os 2 itens de supermercado/);
      return say('Dou baixa nos 2 itens que faltam (detergente e tomate)?')();
    },
  ];
  await handleIncoming(webhook({ conversation: 'comprei tudo' }));
  assert.equal(tables.shopping_items.filter((i) => !i.bought_at).length, 2);

  state.claudeQueue = [toolUse('marcar_comprado', { tudo: true, local: 'supermercado', confirmado_pelo_usuario: true }), say('OK')];
  await handleIncoming(webhook({ conversation: 'sim' }));
  assert.equal(tables.shopping_items.filter((i) => !i.bought_at).length, 0);
  assert.match(lastSent(), /Lista de supermercado completa/);
});

test('lista: "remove o detergente da lista" vai para o agente, não para membros', async () => {
  tables.shopping_items = [{ id: 'd1', family_id: FAMILY, added_by: 'mem-leo', item: 'detergente', quantity: null, store_type: 'supermercado', section: 'limpeza', bought_at: null, created_at: '1' }];
  state.claudeQueue = [toolUse('remover_da_lista', { itens: ['detergente'] }), say('OK')];
  await handleIncoming(webhook({ conversation: 'remove o detergente da lista' }));
  assert.equal(tables.shopping_items.length, 0);
  assert.match(lastSent(), /Tirei da lista: detergente/);
});
