import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addedText, findItemMatch, formatList, normalizeStore, type ListItem } from '../src/agent/shopping-format.js';
import { parseCommand } from '../src/handlers/commands.js';

const item = (item: string, store_type = 'supermercado', section: string | null = null, extra: Partial<ListItem> = {}): ListItem => ({
  id: item, item, quantity: null, store_type, section, added_by_name: 'Leo', ...extra,
});

test('normaliza o local', () => {
  assert.equal(normalizeStore('mercado'), 'supermercado');
  assert.equal(normalizeStore('Supermercado'), 'supermercado');
  assert.equal(normalizeStore('Farmacia'), 'farmácia');
  assert.equal(normalizeStore('drogaria'), 'farmácia');
  assert.equal(normalizeStore('petshop'), 'pet shop');
  assert.equal(normalizeStore('feira'), 'hortifruti');
  assert.equal(normalizeStore('açougue'), 'açougue');
  assert.equal(normalizeStore(undefined), 'supermercado');
  assert.equal(normalizeStore('loja de roupa'), 'outro');
});

test('lista do supermercado agrupada por seção, com quem anotou', () => {
  const txt = formatList([
    item('detergente', 'supermercado', 'limpeza'),
    item('macarrão', 'supermercado', 'mercearia'),
    item('arroz', 'supermercado', 'mercearia', { quantity: '5 kg', added_by_name: 'Ana' }),
    item('tomate', 'supermercado', 'hortifruti'),
  ], 'supermercado');
  assert.match(txt, /🛒 \*Supermercado\* — 4 itens/);
  // mercearia antes de hortifruti antes de limpeza
  assert.ok(txt.indexOf('Mercearia') < txt.indexOf('Hortifruti') && txt.indexOf('Hortifruti') < txt.indexOf('Limpeza'));
  assert.match(txt, /\*Mercearia:\* macarrão, arroz \(5 kg\)/);
  assert.match(txt, /Anotado por: Leo, Ana/);
  assert.match(txt, /comprei tudo/);
});

test('lista geral separa por local', () => {
  const txt = formatList([item('dipirona', 'farmácia'), item('pão', 'padaria'), item('leite', 'supermercado', 'frios e laticínios')]);
  assert.ok(txt.indexOf('Supermercado') < txt.indexOf('Farmácia') && txt.indexOf('Farmácia') < txt.indexOf('Padaria'));
  assert.match(txt, /💊 \*Farmácia\* — 1 item\ndipirona/);
});

test('lista vazia', () => {
  assert.match(formatList([], 'farmácia'), /Nada anotado para farmácia/);
  assert.match(formatList([]), /lista de compras está vazia/);
});

test('encontra item sem acento e no plural', () => {
  const items = [item('macarrão'), item('tomate'), item('leite integral'), item('pão')];
  assert.equal(findItemMatch(items, 'macarrao')?.item, 'macarrão');
  assert.equal(findItemMatch(items, 'tomates')?.item, 'tomate');
  assert.equal(findItemMatch(items, 'leite')?.item, 'leite integral');
  assert.equal(findItemMatch(items, 'pães')?.item, 'pão');
  assert.equal(findItemMatch(items, 'feijão'), undefined);
});

test('texto de itens anotados', () => {
  const t = addedText([item('macarrão'), item('dipirona', 'farmácia')], [item('arroz')]);
  assert.match(t, /Anotado na lista/);
  assert.match(t, /🛒 Supermercado: macarrão, arroz/);
  assert.match(t, /💊 Farmácia: dipirona/);
  assert.match(t, /arroz já estava na lista/);
});

test('frases da lista não viram comando de membro', () => {
  assert.equal(parseCommand('remove o detergente da lista').kind, 'unknown');
  assert.equal(parseCommand('adiciona na lista 2 pacotes de arroz').kind, 'unknown');
  assert.equal(parseCommand('membros').kind, 'list_members');
  assert.equal(parseCommand('remove Ana').kind, 'remove_member');
});
