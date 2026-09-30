import { db } from '../db/supabase.js';
import type { ToolDefinition } from './claude.js';
import {
  addedText, findItemMatch, formatList, normalizeStore, normText, SECTIONS, STORE_TYPES, type ListItem, type StoreType,
} from './shopping-format.js';
import type { AgentContext } from './tools.js';

type ToolResult = { ok: boolean; resultado: string };

// --------------------------------------------------------------------------------------
// Definições
// --------------------------------------------------------------------------------------

export const shoppingToolDefinitions: ToolDefinition[] = [
  {
    name: 'adicionar_compras',
    description:
      'Anota itens na lista de compras da família. Use para "precisa comprar", "anota", "acabou o/a", "falta". ' +
      'NÃO é gasto: não há valor pago.',
    input_schema: {
      type: 'object',
      properties: {
        itens: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              item: { type: 'string', description: 'Nome do item no singular e minúsculo, ex.: "macarrão", "detergente".' },
              quantidade: { type: 'string', description: 'Quantidade, se dita: "2", "5 kg", "1 pacote".' },
              local: { type: 'string', enum: [...STORE_TYPES], description: 'Onde se compra. Na dúvida, supermercado.' },
              secao: { type: 'string', enum: [...SECTIONS], description: 'Seção dentro do local (principalmente no supermercado).' },
            },
            required: ['item', 'local'],
          },
        },
      },
      required: ['itens'],
    },
  },
  {
    name: 'consultar_compras',
    description:
      'Mostra a lista de compras. Use para "estou no supermercado, precisa algo?", "o que tem na lista?", "o que falta da farmácia?".',
    input_schema: {
      type: 'object',
      properties: {
        local: { type: 'string', enum: [...STORE_TYPES], description: 'Filtra por local. Omita para mostrar tudo.' },
      },
    },
  },
  {
    name: 'marcar_comprado',
    description:
      'Dá baixa em itens comprados ("peguei o macarrão", "comprei o arroz e o feijão"). ' +
      'Para "comprei tudo": pergunte antes e só chame com tudo=true e confirmado_pelo_usuario=true depois do "sim".',
    input_schema: {
      type: 'object',
      properties: {
        itens: { type: 'array', items: { type: 'string' }, description: 'Nomes dos itens comprados.' },
        tudo: { type: 'boolean', description: 'true para dar baixa em todos os itens (do local, se informado).' },
        local: { type: 'string', enum: [...STORE_TYPES] },
        confirmado_pelo_usuario: { type: 'boolean', description: 'Obrigatório true quando tudo=true.' },
      },
    },
  },
  {
    name: 'remover_da_lista',
    description: 'Tira itens da lista sem comprar ("tira o detergente", "não precisa mais de pão").',
    input_schema: {
      type: 'object',
      properties: { itens: { type: 'array', items: { type: 'string' } } },
      required: ['itens'],
    },
  },
];

export const SHOPPING_TOOLS = new Set(shoppingToolDefinitions.map((t) => t.name));

// --------------------------------------------------------------------------------------
// Execução
// --------------------------------------------------------------------------------------

type Row = {
  id: string;
  item: string;
  quantity: string | null;
  store_type: string;
  section: string | null;
  added_by: string | null;
};

const COLS = 'id, item, quantity, store_type, section, added_by';

function toListItem(r: Row, names: Map<string, string>): ListItem {
  return {
    id: r.id, item: r.item, quantity: r.quantity, store_type: r.store_type, section: r.section,
    added_by_name: r.added_by ? (names.get(r.added_by) ?? null) : null,
  };
}

/** Nomes dos membros da família (inclui quem saiu, para a lista mostrar quem anotou). */
async function memberNames(familyId: string): Promise<Map<string, string>> {
  const { data, error } = await db.from('members').select('id, name').eq('family_id', familyId);
  if (error) throw error;
  return new Map(((data ?? []) as { id: string; name: string }[]).map((m) => [m.id, m.name]));
}

/** Itens em aberto (não comprados) da família, opcionalmente de um local. */
export async function openItems(familyId: string, store?: StoreType): Promise<ListItem[]> {
  let q = db.from('shopping_items').select(COLS).eq('family_id', familyId).is('bought_at', null);
  if (store) q = q.eq('store_type', store);
  const [{ data, error }, names] = await Promise.all([q.order('created_at', { ascending: true }), memberNames(familyId)]);
  if (error) throw error;
  return ((data ?? []) as Row[]).map((r) => toListItem(r, names));
}

const SECTION_SET = new Set<string>(SECTIONS);
const cleanSection = (s: unknown) => (typeof s === 'string' && SECTION_SET.has(normTextKeep(s)) ? normTextKeep(s) : null);
function normTextKeep(s: string) {
  // seções têm acento ("frios e laticínios", "bebê"): compara sem acento, devolve a forma canônica
  const n = normText(s);
  return SECTIONS.find((x) => normText(x) === n) ?? s;
}

export async function executeShoppingTool(name: string, input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const familyId = ctx.member.family_id;

  switch (name) {
    case 'adicionar_compras': {
      const raw = Array.isArray(input.itens) ? (input.itens as Record<string, unknown>[]) : [];
      const wanted = raw
        .map((i) => ({
          item: typeof i.item === 'string' ? i.item.trim().toLowerCase() : '',
          quantity: typeof i.quantidade === 'string' && i.quantidade.trim() ? i.quantidade.trim() : null,
          store_type: normalizeStore(i.local),
          section: cleanSection(i.secao),
        }))
        .filter((i) => i.item);
      if (!wanted.length) return { ok: false, resultado: 'Nenhum item informado. Pergunte o que anotar.' };

      const open = await openItems(familyId);
      const added: ListItem[] = [];
      const merged: ListItem[] = [];
      for (const w of wanted) {
        // Mesmo item já na lista (no mesmo local): não duplica, só atualiza a quantidade
        const existing = findItemMatch(open.filter((o) => o.store_type === w.store_type), w.item);
        if (existing && normText(existing.item).replace(/s$/, '') === normText(w.item).replace(/s$/, '')) {
          if (w.quantity && w.quantity !== existing.quantity) {
            const { error } = await db.from('shopping_items').update({ quantity: w.quantity }).eq('id', existing.id);
            if (error) throw error;
            existing.quantity = w.quantity;
          }
          merged.push(existing);
          continue;
        }
        const { data, error } = await db
          .from('shopping_items')
          .insert({ family_id: familyId, added_by: ctx.member.id, ...w })
          .select(COLS)
          .single();
        if (error) throw error;
        const item = toListItem(data as Row, new Map([[ctx.member.id, ctx.member.name]]));
        added.push(item);
        open.push(item);
      }
      ctx.replies.push(addedText(added, merged));
      return { ok: true, resultado: `${added.length} item(ns) anotado(s), ${merged.length} já estava(m) na lista. A confirmação já foi enviada.` };
    }

    case 'consultar_compras': {
      const store = input.local ? normalizeStore(input.local) : undefined;
      const items = await openItems(familyId, store);
      ctx.replies.push(formatList(items, store));
      return { ok: true, resultado: `Lista enviada (${items.length} itens). A confirmação já foi enviada.` };
    }

    case 'marcar_comprado': {
      const store = input.local ? normalizeStore(input.local) : undefined;
      const open = await openItems(familyId, store);
      if (!open.length) return { ok: false, resultado: 'A lista (desse local) já está vazia.' };

      let targets: ListItem[] = [];
      const notFound: string[] = [];
      if (input.tudo === true) {
        if (input.confirmado_pelo_usuario !== true) {
          return {
            ok: false,
            resultado: `Ainda não confirmado. Pergunte: "Dou baixa em todos os ${open.length} itens${store ? ` de ${store}` : ''}?"`,
          };
        }
        targets = open;
      } else {
        const names = Array.isArray(input.itens) ? (input.itens as unknown[]).filter((x): x is string => typeof x === 'string') : [];
        if (!names.length) return { ok: false, resultado: 'Diga quais itens foram comprados.' };
        for (const n of names) {
          const m = findItemMatch(open.filter((o) => !targets.includes(o)), n);
          if (m) targets.push(m);
          else notFound.push(n);
        }
      }
      if (targets.length) {
        const { error } = await db
          .from('shopping_items')
          .update({ bought_at: new Date().toISOString(), bought_by: ctx.member.id })
          .in('id', targets.map((t) => t.id));
        if (error) throw error;
      }
      const remaining = open.length - targets.length;
      const parts = [];
      if (targets.length) parts.push(`✅ Comprado: ${targets.map((t) => t.item).join(', ')}`);
      if (notFound.length) parts.push(`❓ Não achei na lista: ${notFound.join(', ')}`);
      parts.push(remaining ? `Ainda falta${remaining > 1 ? 'm' : ''} ${remaining} ${remaining > 1 ? 'itens' : 'item'}${store ? ` de ${store}` : ''}.` : `🎉 Lista${store ? ` de ${store}` : ''} completa!`);
      ctx.replies.push(parts.join('\n'));
      return { ok: true, resultado: `${targets.length} marcado(s) como comprado(s). A confirmação já foi enviada.` };
    }

    case 'remover_da_lista': {
      const names = Array.isArray(input.itens) ? (input.itens as unknown[]).filter((x): x is string => typeof x === 'string') : [];
      const open = await openItems(familyId);
      const targets: ListItem[] = [];
      const notFound: string[] = [];
      for (const n of names) {
        const m = findItemMatch(open.filter((o) => !targets.includes(o)), n);
        if (m) targets.push(m);
        else notFound.push(n);
      }
      if (targets.length) {
        const { error } = await db.from('shopping_items').delete().in('id', targets.map((t) => t.id)).eq('family_id', familyId);
        if (error) throw error;
      }
      const parts = [];
      if (targets.length) parts.push(`🗑️ Tirei da lista: ${targets.map((t) => t.item).join(', ')}`);
      if (notFound.length) parts.push(`❓ Não achei na lista: ${notFound.join(', ')}`);
      ctx.replies.push(parts.join('\n') || 'Nada para tirar.');
      return { ok: targets.length > 0, resultado: `${targets.length} removido(s). A confirmação já foi enviada.` };
    }

    default:
      return { ok: false, resultado: `Ferramenta desconhecida: ${name}` };
  }
}
