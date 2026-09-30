import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCommand } from '../src/handlers/commands.js';
import { parseEvolutionWebhook } from '../src/whatsapp/parse.js';
import { normalizeBrPhone, phoneVariants } from '../src/whatsapp/phone.js';

const upsert = (key: object, message: object, extra: object = {}) => ({
  event: 'messages.upsert',
  instance: 'agente-familiar',
  data: { key, message, pushName: 'Leo', messageTimestamp: 1759197000, ...extra },
});

test('texto no privado', () => {
  const m = parseEvolutionWebhook(upsert(
    { remoteJid: '5534999999999@s.whatsapp.net', fromMe: false, id: 'ABC1' },
    { conversation: ' gastei 50 de gasolina ' },
  ));
  assert.equal(m?.type, 'text');
  assert.equal(m?.text, 'gastei 50 de gasolina');
  assert.equal(m?.senderPhone, '5534999999999');
  assert.equal(m?.isGroup, false);
});

test('ignora mensagens enviadas pelo próprio agente e status', () => {
  assert.equal(parseEvolutionWebhook(upsert({ remoteJid: '5534999999999@s.whatsapp.net', fromMe: true, id: 'X' }, { conversation: 'oi' })), null);
  assert.equal(parseEvolutionWebhook(upsert({ remoteJid: 'status@broadcast', fromMe: false, id: 'Y' }, { conversation: 'oi' })), null);
  assert.equal(parseEvolutionWebhook({ event: 'connection.update', data: {} }), null);
});

test('evento em MAIÚSCULAS (MESSAGES_UPSERT) também é aceito', () => {
  const body = { ...upsert({ remoteJid: '5534999999999@s.whatsapp.net', fromMe: false, id: 'Z' }, { conversation: 'oi' }), event: 'MESSAGES_UPSERT' };
  assert.equal(parseEvolutionWebhook(body)?.text, 'oi');
});

test('imagem com legenda e base64', () => {
  const m = parseEvolutionWebhook(upsert(
    { remoteJid: '5534999999999@s.whatsapp.net', fromMe: false, id: 'IMG' },
    { imageMessage: { caption: 'mercado', mimetype: 'image/jpeg' }, base64: 'AAAA' },
  ));
  assert.equal(m?.type, 'image');
  assert.equal(m?.text, 'mercado');
  assert.equal(m?.mediaBase64, 'AAAA');
});

test('áudio', () => {
  const m = parseEvolutionWebhook(upsert(
    { remoteJid: '5534999999999@s.whatsapp.net', fromMe: false, id: 'AUD' },
    { audioMessage: { mimetype: 'audio/ogg; codecs=opus' } },
  ));
  assert.equal(m?.type, 'audio');
});

test('grupo usa o participant como remetente', () => {
  const m = parseEvolutionWebhook(upsert(
    { remoteJid: '120363000000000000@g.us', participant: '5534988887777@s.whatsapp.net', fromMe: false, id: 'G1' },
    { conversation: 'assistente, oi' },
  ));
  assert.equal(m?.isGroup, true);
  assert.equal(m?.senderPhone, '5534988887777');
  assert.equal(m?.remoteJid, '120363000000000000@g.us');
});

test('remetente @lid usa senderPn', () => {
  const m = parseEvolutionWebhook(upsert(
    { remoteJid: '123456789@lid', senderPn: '5534999999999@s.whatsapp.net', fromMe: false, id: 'L1' },
    { conversation: 'oi' },
  ));
  assert.equal(m?.senderPhone, '5534999999999');
});

test('@lid sem número real é ignorado', () => {
  assert.equal(parseEvolutionWebhook(upsert({ remoteJid: '123456789@lid', fromMe: false, id: 'L2' }, { conversation: 'oi' })), null);
});

test('normaliza telefones brasileiros', () => {
  assert.equal(normalizeBrPhone('(34) 99999-9999'), '5534999999999');
  assert.equal(normalizeBrPhone('+55 34 99999-9999'), '5534999999999');
  assert.equal(normalizeBrPhone('34 9999-9999'), '5534999999999'); // celular sem o 9
  assert.equal(normalizeBrPhone('34 3333-4444'), '553433334444');  // fixo fica como está
  assert.equal(normalizeBrPhone('123'), null);
});

test('variantes com e sem o 9', () => {
  assert.deepEqual(phoneVariants('5534999999999').sort(), ['553499999999', '5534999999999'].sort());
  assert.deepEqual(phoneVariants('553499999999').sort(), ['553499999999', '5534999999999'].sort());
});

test('comandos', () => {
  assert.equal(parseCommand('Oi!').kind, 'greeting');
  assert.equal(parseCommand('Olá').kind, 'greeting');
  assert.equal(parseCommand('ajuda').kind, 'help');
  assert.equal(parseCommand('membros').kind, 'list_members');
  assert.deepEqual(parseCommand('adiciona Ana Paula 34 99999-8888'), {
    kind: 'add_member', name: 'Ana Paula', phone: '5534999998888', admin: false,
  });
  assert.deepEqual(parseCommand('adicionar admin João (34) 98888-7777'), {
    kind: 'add_member', name: 'João', phone: '5534988887777', admin: true,
  });
  assert.equal(parseCommand('adiciona Ana').kind, 'invalid');
  assert.deepEqual(parseCommand('remove Ana'), { kind: 'remove_member', target: 'Ana' });
  assert.equal(parseCommand('gastei 50 no mercado').kind, 'unknown');
});
