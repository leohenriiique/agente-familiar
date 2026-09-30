import { db, type Member } from '../db/supabase.js';
import type { ToolDefinition } from './claude.js';
import { executeShoppingTool, SHOPPING_TOOLS, shoppingToolDefinitions } from './shopping.js';
import {
  confirmationText, formatBRL, parseLocalDateTime, pendingText, toCents, updatedText, type ExpenseView,
} from './format.js';

export type Category = { id: string; name: string; emoji: string | null };

export type AgentContext = {
  member: Member;
  categories: Category[];
  source: 'texto' | 'audio' | 'imagem';
  receiptPath: string | null;
  messageTime: Date;
  /** Textos prontos que as ferramentas geram (confirmações). São enviados como estão. */
  replies: string[];
};

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export function matchCategory(categories: Category[], name: unknown): Category | undefined {
  if (typeof name !== 'string' || !name.trim()) return undefined;
  const n = norm(name);
  return categories.find((c) => norm(c.name) === n) ?? categories.find((c) => norm(c.name).includes(n) || n.includes(norm(c.name)));
}

const centsFrom = (v: unknown) => (typeof v === 'number' || typeof v === 'string' ? toCents(v) : null);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// --------------------------------------------------------------------------------------
// Definições enviadas ao Claude
// --------------------------------------------------------------------------------------

export function toolDefinitions(categories: Category[]): ToolDefinition[] {
  const categoryNames = categories.map((c) => c.name);
  const expenseFields = {
    valor: { type: 'number', description: 'Valor em reais, ex.: 45.9 para R$ 45,90. No cupom, use o TOTAL pago (depois de descontos).' },
    categoria: { type: 'string', enum: categoryNames, description: 'Categoria da família que melhor descreve o gasto.' },
    descricao: { type: 'string', description: 'Descrição curta do que foi comprado, ex.: "gasolina", "compras da semana".' },
    estabelecimento: { type: 'string', description: 'Nome da loja/estabelecimento, se souber.' },
    data_hora: { type: 'string', description: 'Quando foi o gasto, no horário de São Paulo: "AAAA-MM-DDTHH:MM", ou só "AAAA-MM-DD" se não souber a hora. Omita se foi agora.' },
    forma_pagamento: { type: 'string', enum: ['Pix', 'Crédito', 'Débito', 'Dinheiro', 'Boleto', 'Outro'], description: 'Forma de pagamento, se informada ou visível no comprovante.' },
  };

  return [
    ...shoppingToolDefinitions,
    {
      name: 'registrar_gasto',
      description:
        'Registra um gasto da família. Use quando a pessoa informar algo que comprou/pagou ou mandar foto de cupom, nota ou comprovante. ' +
        'Não use se faltar o valor: pergunte antes.',
      input_schema: {
        type: 'object',
        properties: {
          ...expenseFields,
          precisa_confirmar: {
            type: 'boolean',
            description: 'true quando a leitura é incerta (valor ilegível, mais de um total possível, foto ruim, áudio confuso). O gasto fica pendente até a pessoa confirmar.',
          },
        },
        required: ['valor', 'categoria', 'descricao'],
      },
    },
    {
      name: 'confirmar_gasto',
      description: 'Confirma um gasto que ficou pendente, quando a pessoa responde "sim", "isso", "confirma" etc.',
      input_schema: {
        type: 'object',
        properties: { gasto_id: { type: 'string', description: 'id do gasto pendente (veja "Gastos recentes"). Omita para usar o último.' } },
      },
    },
    {
      name: 'corrigir_gasto',
      description: 'Corrige campos de um gasto já registrado ("na verdade foi 45", "muda para Saúde", "foi ontem"). Envie só os campos que mudam.',
      input_schema: {
        type: 'object',
        properties: {
          gasto_id: { type: 'string', description: 'id do gasto (veja "Gastos recentes"). Omita para o último gasto desta pessoa.' },
          ...expenseFields,
        },
      },
    },
    {
      name: 'excluir_gasto',
      description:
        'Apaga um gasto. SEMPRE pergunte antes ("Posso apagar o gasto de R$ X em Y?") e só chame com confirmado_pelo_usuario=true depois que a pessoa disser sim.',
      input_schema: {
        type: 'object',
        properties: {
          gasto_id: { type: 'string', description: 'id do gasto. Omita para o último gasto desta pessoa.' },
          confirmado_pelo_usuario: { type: 'boolean' },
        },
        required: ['confirmado_pelo_usuario'],
      },
    },
  ];
}

// --------------------------------------------------------------------------------------
// Execução
// --------------------------------------------------------------------------------------

type ExpenseRow = {
  id: string;
  family_id: string;
  member_id: string | null;
  category_id: string | null;
  amount_cents: number;
  description: string | null;
  merchant: string | null;
  spent_at: string;
  payment_method: string | null;
  status: 'confirmado' | 'pendente';
};

const EXPENSE_COLS = 'id, family_id, member_id, category_id, amount_cents, description, merchant, spent_at, payment_method, status';

function view(row: ExpenseRow, ctx: AgentContext): ExpenseView {
  const cat = ctx.categories.find((c) => c.id === row.category_id);
  return {
    amount_cents: row.amount_cents,
    categoryName: cat?.name ?? 'Outros',
    categoryEmoji: cat?.emoji,
    merchant: row.merchant,
    description: row.description,
    spent_at: new Date(row.spent_at),
    memberName: ctx.member.name,
    payment_method: row.payment_method,
  };
}

/** Busca o gasto pelo id (sempre dentro da família) ou o último desta pessoa. */
async function findExpense(ctx: AgentContext, id: unknown, onlyPending = false): Promise<ExpenseRow | null> {
  let q = db.from('expenses').select(EXPENSE_COLS).eq('family_id', ctx.member.family_id);
  if (typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)) q = q.eq('id', id);
  else q = q.eq('member_id', ctx.member.id);
  if (onlyPending) q = q.eq('status', 'pendente');
  const { data, error } = await q.order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return (data as ExpenseRow) ?? null;
}

type ToolResult = { ok: boolean; resultado: string };

export async function executeTool(name: string, input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  if (SHOPPING_TOOLS.has(name)) return executeShoppingTool(name, input, ctx);
  switch (name) {
    case 'registrar_gasto': {
      const cents = centsFrom(input.valor);
      if (!cents) return { ok: false, resultado: 'Valor inválido ou ausente. Pergunte o valor à pessoa.' };
      const category = matchCategory(ctx.categories, input.categoria) ?? matchCategory(ctx.categories, 'Outros');
      const pending = input.precisa_confirmar === true;
      const { data, error } = await db
        .from('expenses')
        .insert({
          family_id: ctx.member.family_id,
          member_id: ctx.member.id,
          category_id: category?.id ?? null,
          amount_cents: cents,
          description: str(input.descricao),
          merchant: str(input.estabelecimento),
          spent_at: parseLocalDateTime(str(input.data_hora), ctx.messageTime).toISOString(),
          payment_method: str(input.forma_pagamento),
          source: ctx.source,
          receipt_path: ctx.receiptPath,
          status: pending ? 'pendente' : 'confirmado',
        })
        .select(EXPENSE_COLS)
        .single();
      if (error) throw error;
      const row = data as ExpenseRow;
      ctx.replies.push(pending ? pendingText(view(row, ctx)) : confirmationText(view(row, ctx)));
      return {
        ok: true,
        resultado: `${pending ? 'Gasto salvo como PENDENTE' : 'Gasto registrado'} (id ${row.id}): ${formatBRL(row.amount_cents)}. A confirmação já foi enviada à pessoa.`,
      };
    }

    case 'confirmar_gasto': {
      const row = await findExpense(ctx, input.gasto_id, true);
      if (!row) return { ok: false, resultado: 'Não há gasto pendente para confirmar.' };
      const { data, error } = await db.from('expenses').update({ status: 'confirmado' }).eq('id', row.id).select(EXPENSE_COLS).single();
      if (error) throw error;
      ctx.replies.push(confirmationText(view(data as ExpenseRow, ctx)));
      return { ok: true, resultado: `Gasto ${row.id} confirmado. A confirmação já foi enviada.` };
    }

    case 'corrigir_gasto': {
      const row = await findExpense(ctx, input.gasto_id);
      if (!row) return { ok: false, resultado: 'Não encontrei esse gasto.' };
      const patch: Record<string, unknown> = {};
      if (input.valor !== undefined) {
        const cents = centsFrom(input.valor);
        if (!cents) return { ok: false, resultado: 'Valor inválido.' };
        patch.amount_cents = cents;
      }
      if (input.categoria !== undefined) {
        const category = matchCategory(ctx.categories, input.categoria);
        if (!category) return { ok: false, resultado: `Categoria "${String(input.categoria)}" não existe.` };
        patch.category_id = category.id;
      }
      if (str(input.descricao)) patch.description = str(input.descricao);
      if (str(input.estabelecimento)) patch.merchant = str(input.estabelecimento);
      if (str(input.forma_pagamento)) patch.payment_method = str(input.forma_pagamento);
      if (str(input.data_hora)) patch.spent_at = parseLocalDateTime(str(input.data_hora), new Date(row.spent_at)).toISOString();
      if (Object.keys(patch).length === 0) return { ok: false, resultado: 'Nada para corrigir. Pergunte o que deve mudar.' };
      // Corrigir um gasto pendente também é confirmar o que foi lido
      patch.status = 'confirmado';
      const { data, error } = await db.from('expenses').update(patch).eq('id', row.id).select(EXPENSE_COLS).single();
      if (error) throw error;
      ctx.replies.push(updatedText(view(data as ExpenseRow, ctx)));
      return { ok: true, resultado: `Gasto ${row.id} atualizado. A confirmação já foi enviada.` };
    }

    case 'excluir_gasto': {
      const row = await findExpense(ctx, input.gasto_id);
      if (!row) return { ok: false, resultado: 'Não encontrei esse gasto.' };
      if (input.confirmado_pelo_usuario !== true) {
        return {
          ok: false,
          resultado: `Ainda não confirmado. Pergunte: "Posso apagar o gasto de ${formatBRL(row.amount_cents)} (${row.description ?? 'sem descrição'})?"`,
        };
      }
      const { error } = await db.from('expenses').delete().eq('id', row.id).eq('family_id', ctx.member.family_id);
      if (error) throw error;
      ctx.replies.push(`🗑️ Gasto de ${formatBRL(row.amount_cents)} (${row.description ?? 'sem descrição'}) apagado.`);
      return { ok: true, resultado: 'Gasto apagado. A confirmação já foi enviada.' };
    }

    default:
      return { ok: false, resultado: `Ferramenta desconhecida: ${name}` };
  }
}
