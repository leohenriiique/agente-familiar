/**
 * Formatação da lista de compras (funções puras, testadas em tests/phase3.test.ts).
 */

export const STORE_TYPES = [
  'supermercado', 'farmácia', 'açougue', 'hortifruti', 'padaria', 'pet shop', 'material de construção', 'outro',
] as const;
export type StoreType = (typeof STORE_TYPES)[number];

export const SECTIONS = [
  'mercearia', 'hortifruti', 'carnes', 'frios e laticínios', 'padaria', 'bebidas', 'limpeza', 'higiene',
  'congelados', 'pet', 'bebê', 'outros',
] as const;

const STORE_EMOJI: Record<string, string> = {
  supermercado: '🛒', farmácia: '💊', açougue: '🥩', hortifruti: '🥬', padaria: '🥖',
  'pet shop': '🐾', 'material de construção': '🔨', outro: '📦',
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const normText = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Aceita variações ("mercado", "Farmacia", "petshop") e devolve o local canônico. */
export function normalizeStore(input: unknown): StoreType {
  if (typeof input !== 'string') return 'supermercado';
  const s = normText(input).replace(/[^a-z ]/g, '').replace(/\s+/g, ' ');
  if (!s) return 'supermercado';
  if (/^(super)?mercado|atacad|sacolao/.test(s)) return /sacolao/.test(s) ? 'hortifruti' : 'supermercado';
  if (/farmac|drogaria/.test(s)) return 'farmácia';
  if (/acougue/.test(s)) return 'açougue';
  if (/hortifruti|feira|quitanda/.test(s)) return 'hortifruti';
  if (/padaria|panificadora/.test(s)) return 'padaria';
  if (/pet/.test(s)) return 'pet shop';
  if (/construc|ferragem|ferragista/.test(s)) return 'material de construção';
  return 'outro';
}

export type ListItem = {
  id: string;
  item: string;
  quantity: string | null;
  store_type: string;
  section: string | null;
  added_by_name?: string | null;
};

function itemLabel(i: ListItem) {
  return i.quantity ? `${i.item} (${i.quantity})` : i.item;
}

/** Uma loja: "🛒 *Supermercado* — 5 itens" + linhas por seção + quem anotou. */
function storeBlock(store: string, items: ListItem[]): string {
  const bySection = new Map<string, ListItem[]>();
  for (const i of items) {
    const sec = i.section && i.section !== 'outros' ? i.section : 'outros';
    bySection.set(sec, [...(bySection.get(sec) ?? []), i]);
  }
  // mantém a ordem de SECTIONS, com "outros" por último
  const order = (s: string) => {
    const idx = (SECTIONS as readonly string[]).indexOf(s);
    return idx === -1 ? SECTIONS.length - 1 : idx;
  };
  const sections = [...bySection.keys()].sort((a, b) => order(a) - order(b));

  const lines = [`${STORE_EMOJI[store] ?? '📦'} *${cap(store)}* — ${items.length} ${items.length === 1 ? 'item' : 'itens'}`];
  if (sections.length === 1 && sections[0] === 'outros') {
    lines.push(items.map(itemLabel).join(', '));
  } else {
    for (const sec of sections) lines.push(`*${cap(sec)}:* ${bySection.get(sec)!.map(itemLabel).join(', ')}`);
  }
  const who = [...new Set(items.map((i) => i.added_by_name).filter(Boolean))];
  if (who.length) lines.push(`_Anotado por: ${who.join(', ')}_`);
  return lines.join('\n');
}

/** Lista completa ou de um local. Vazia → mensagem própria. */
export function formatList(items: ListItem[], store?: StoreType): string {
  if (items.length === 0) {
    return store ? `${STORE_EMOJI[store] ?? '📦'} Nada anotado para ${store}. 🎉` : '📝 A lista de compras está vazia. 🎉';
  }
  const byStore = new Map<string, ListItem[]>();
  for (const i of items) byStore.set(i.store_type, [...(byStore.get(i.store_type) ?? []), i]);
  const stores = [...byStore.keys()].sort(
    (a, b) => (STORE_TYPES as readonly string[]).indexOf(a) - (STORE_TYPES as readonly string[]).indexOf(b),
  );
  const blocks = stores.map((s) => storeBlock(s, byStore.get(s)!));
  const footer = store
    ? 'Quando pegar, me avise: _"peguei o macarrão"_ ou _"comprei tudo"_.'
    : 'Diga _"estou no supermercado"_ para ver só um local.';
  return [...blocks, '', footer].join('\n\n').replace(/\n\n\n+/g, '\n\n');
}

export function addedText(added: ListItem[], merged: ListItem[]): string {
  const all = [...added, ...merged];
  const byStore = new Map<string, string[]>();
  for (const i of all) byStore.set(i.store_type, [...(byStore.get(i.store_type) ?? []), itemLabel(i)]);
  const lines = [...byStore.entries()].map(([s, its]) => `${STORE_EMOJI[s] ?? '📦'} ${cap(s)}: ${its.join(', ')}`);
  const note = merged.length ? `\n_(${merged.map((m) => m.item).join(', ')} já estava na lista: atualizei)_` : '';
  return `📝 *Anotado na lista*\n${lines.join('\n')}${note}`;
}

/**
 * Casa um nome dito pela pessoa com um item da lista, sem acento e aceitando plural simples:
 * "macarrão" ↔ "macarrao", "tomates" ↔ "tomate", "leite" ↔ "leite integral".
 */
export function findItemMatch<T extends { item: string }>(items: T[], query: string): T | undefined {
  const q = normText(query);
  const singular = (s: string) => s.replace(/(oes|aes)$/, 'ao').replace(/s$/, '');
  const qs = singular(q);
  return (
    items.find((i) => normText(i.item) === q) ??
    items.find((i) => singular(normText(i.item)) === qs) ??
    items.find((i) => normText(i.item).startsWith(qs) || qs.startsWith(singular(normText(i.item)))) ??
    items.find((i) => normText(i.item).includes(qs))
  );
}
