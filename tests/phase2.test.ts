import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  confirmationText, formatBRL, formatDateTime, localIso, parseLocalDateTime, pendingText, toCents,
} from '../src/agent/format.js';
import { parseCommand } from '../src/handlers/commands.js';
import { baseMime, extFromMime, isClaudeImage } from '../src/media/mime.js';

test('valores em reais → centavos', () => {
  assert.equal(toCents(187.4), 18740);
  assert.equal(toCents(0.1 + 0.2), 30); // sem erro de arredondamento
  assert.equal(toCents('45,90'), 4590);
  assert.equal(toCents('R$ 1.234,56'), 123456);
  assert.equal(toCents('45.90'), 4590);
  assert.equal(toCents(0), null);
  assert.equal(toCents(-5), null);
  assert.equal(toCents('abc'), null);
});

test('formatação em reais', () => {
  assert.equal(formatBRL(18740), 'R$ 187,40');
  assert.equal(formatBRL(123456), 'R$ 1.234,56');
});

test('data e hora de São Paulo', () => {
  const d = new Date('2026-09-29T21:42:00Z'); // 18:42 em SP
  assert.equal(formatDateTime(d), '29/09/2026 às 18:42');
  assert.equal(localIso(d), '2026-09-29T18:42');
});

test('interpreta data/hora devolvida pelo modelo', () => {
  const now = new Date('2026-09-30T15:00:00Z');
  const fb = new Date('2026-09-30T14:59:00Z');
  assert.equal(parseLocalDateTime('2026-09-29T18:42', fb, now).toISOString(), '2026-09-29T21:42:00.000Z');
  assert.equal(parseLocalDateTime('2026-09-29', fb, now).toISOString(), '2026-09-29T15:00:00.000Z'); // meio-dia em SP
  assert.equal(parseLocalDateTime('2026-09-29 08:05:30', fb, now).toISOString(), '2026-09-29T11:05:30.000Z');
  assert.equal(parseLocalDateTime(undefined, fb, now), fb);
  assert.equal(parseLocalDateTime('ontem', fb, now), fb); // inválido → fallback
  assert.equal(parseLocalDateTime('2026-10-05T10:00', fb, now), fb); // futuro → fallback
});

test('textos de confirmação', () => {
  const e = {
    amount_cents: 18740, categoryName: 'Mercado', categoryEmoji: '🛒', merchant: 'Supermercado Bretas',
    description: 'compras da semana', spent_at: new Date('2026-09-29T21:42:00Z'), memberName: 'Leo', payment_method: 'Pix',
  };
  const c = confirmationText(e);
  assert.match(c, /Gasto registrado/);
  assert.match(c, /R\$ 187,40/);
  assert.match(c, /🛒 Mercado — Supermercado Bretas — compras da semana/);
  assert.match(c, /29\/09\/2026 às 18:42/);
  assert.match(c, /💳 Pix/);
  assert.match(c, /👤 Leo/);
  assert.match(pendingText(e), /Responda \*sim\*/);
});

test('tipos de mídia', () => {
  assert.equal(baseMime('audio/ogg; codecs=opus', 'audio/ogg'), 'audio/ogg');
  assert.equal(baseMime(undefined, 'image/jpeg'), 'image/jpeg');
  assert.equal(extFromMime('audio/ogg'), 'ogg');
  assert.equal(extFromMime('image/jpeg'), 'jpg');
  assert.equal(isClaudeImage('image/jpeg'), true);
  assert.equal(isClaudeImage('image/heic'), false);
});

test('frases de gasto não viram comando de membro', () => {
  assert.equal(parseCommand('remove o último gasto').kind, 'unknown');
  assert.equal(parseCommand('adiciona gasto de 50 na farmácia').kind, 'unknown');
  assert.equal(parseCommand('adiciona 35,90 de farmácia').kind, 'unknown');
  assert.equal(parseCommand('adiciona 50 de gasolina').kind, 'unknown');
  assert.equal(parseCommand('sim').kind, 'unknown');
  // comandos de membro continuam funcionando
  assert.equal(parseCommand('adiciona Ana 34 99999-8888').kind, 'add_member');
  assert.equal(parseCommand('adiciona Ana').kind, 'invalid');
  assert.equal(parseCommand('remove Ana').kind, 'remove_member');
});
