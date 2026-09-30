/**
 * Situação atual: sem chave do Claude, com chave da OpenAI.
 * Áudio é transcrito e foto é guardada, mas gastos ainda não são registrados.
 */
import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { claudeRequests, fakeDb, sent, state, tables, uploads } from './harness.js';

Object.assign(process.env, {
  WEBHOOK_TOKEN: 'token-de-teste-1234567',
  EVOLUTION_URL: 'http://evolution.test',
  EVOLUTION_API_KEY: 'k',
  EVOLUTION_INSTANCE: 'agente-familiar',
  SUPABASE_URL: 'http://supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'k',
  ANTHROPIC_API_KEY: '',
  OPENAI_API_KEY: 'sk-teste',
});
mock.module(new URL('../../src/db/supabase.ts', import.meta.url).href, { namedExports: { db: fakeDb } });
const { handleIncoming } = await import('../../src/handlers/incoming.js');
const { parseEvolutionWebhook } = await import('../../src/whatsapp/parse.js');

let n = 0;
const webhook = (message: Record<string, unknown>) =>
  parseEvolutionWebhook({
    event: 'messages.upsert',
    data: { key: { remoteJid: '5534999999999@s.whatsapp.net', fromMe: false, id: `OFF${++n}` }, message, messageTimestamp: 1790780000 },
  })!;

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  tables.members = [{ id: 'mem-leo', family_id: 'fam-1', name: 'Leo', phone: '5534999999999', role: 'admin', active: true }];
  sent.length = 0;
  uploads.length = 0;
});

test('texto de gasto: avisa que ainda não está ativo', async () => {
  await handleIncoming(webhook({ conversation: 'gastei 50 de gasolina' }));
  assert.match(sent.at(-1)!.text, /ainda não está ativo/);
  assert.equal(claudeRequests.length, 0);
  assert.equal(tables.expenses, undefined);
});

test('áudio: já transcreve e mostra o que entendeu', async () => {
  state.transcription = 'gastei 30 na padaria';
  await handleIncoming(webhook({ audioMessage: { mimetype: 'audio/ogg' }, base64: 'AAAA' }));
  assert.match(sent.at(-1)!.text, /^🎙️ _"gastei 30 na padaria"_/);
  assert.match(sent.at(-1)!.text, /ainda não está ativo/);
  assert.equal(uploads.length, 1);
});

test('áudio com comando ("oi") já funciona', async () => {
  state.transcription = 'Oi!';
  await handleIncoming(webhook({ audioMessage: { mimetype: 'audio/ogg' }, base64: 'AAAA' }));
  assert.match(sent.at(-1)!.text, /Oi, Leo/);
});

test('foto: guarda o arquivo e avisa', async () => {
  await handleIncoming(webhook({ imageMessage: { mimetype: 'image/jpeg' }, base64: 'AAAA' }));
  assert.equal(uploads.length, 1);
  assert.match(sent.at(-1)!.text, /Foto guardada/);
  assert.equal(claudeRequests.length, 0);
});
