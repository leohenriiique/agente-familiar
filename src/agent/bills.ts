import { db } from '../db/supabase.js';
import type { ToolDefinition } from './claude.js';
import { confirmationText, formatBRL, toCents } from './format.js';
import { BILL_COLS, cancelPendingReminders, ensureBillOccurrences, type BillRow } from './reminders.js';
import { addDays, billCreatedText, billListText, localYmd, type PaymentView } from './schedule-format.js';
import { findItemMatch } from './shopping-format.js';
import { matchCategory, type AgentContext } from './tools.js';

type ToolResult = { ok: boolean; resultado: string };

export const billToolDefinitions: ToolDefinition[] = [
  {
    name: 'cadastrar_conta',
    description:
      'Cadastra uma conta a pagar com lembrete ("internet vence todo dia 15, 120 reais", "IPVA todo ano em 20/03", "boleto do curso dia 05/11"). ' +
      'Se faltar o vencimento, pergunte antes.',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Nome curto: "Internet", "Luz", "Aluguel", "IPVA".' },
        valor: { type: 'number', description: 'Valor em reais, se souber (pode ser aproximado).' },
        recorrencia: { type: 'string', enum: ['mensal', 'anual', 'unica'] },
        dia_vencimento: { type: 'number', description: 'Dia do mês (1-31) para mensal e anual.' },
        mes_vencimento: { type: 'number', description: 'Mês (1-12), só para anual.' },
        data_vencimento: { type: 'string', description: '"AAAA-MM-DD", só para única.' },
        lembrar_dias_antes: { type: 'array', items: { type: 'number' }, description: 'Dias antes para lembrar. Padrão [3, 0] (3 dias antes e no dia).' },
      },
      required: ['nome', 'recorrencia'],
    },
  },
  {
    name: 'listar_contas',
    description: 'Mostra contas a pagar ("quais contas vencem esse mês?", "tem conta atrasada?", "contas da semana").',
    input_schema: {
      type: 'object',
      properties: { periodo: { type: 'string', enum: ['proximos_30_dias', 'este_mes', 'vencidas'], description: 'Padrão: proximos_30_dias.' } },
    },
  },
  {
    name: 'pagar_conta',
    description:
      'Marca a conta como paga ("paguei a internet", "paguei a luz, deu 187"). ' +
      'registrar_como_gasto=true também lança o valor nos gastos (padrão true).',
    input_schema: {
      type: 'object',
      properties: {
        conta: { type: 'string', description: 'Nome da conta.' },
        valor_pago: { type: 'number', description: 'Valor pago em reais, se a pessoa disser.' },
        registrar_como_gasto: { type: 'boolean' },
      },
      required: ['conta'],
    },
  },
  {
    name: 'excluir_conta',
    description: 'Para de acompanhar uma conta ("cancelei a TV a cabo"). Pergunte antes; só com confirmado_pelo_usuario=true.',
    input_schema: {
      type: 'object',
      properties: { conta: { type: 'string' }, confirmado_pelo_usuario: { type: 'boolean' } },
      required: ['conta', 'confirmado_pelo_usuario'],
    },
  },
];

export const BILL_TOOLS = new Set(billToolDefinitions.map((t) => t.name));

async function activeBills(familyId: string): Promise<BillRow[]> {
  const { data, error } = await db.from('bills').select(BILL_COLS).eq('family_id', familyId).eq('active', true);
  if (error) throw error;
  return (data ?? []) as BillRow[];
}

function findBill(bills: BillRow[], name: unknown): BillRow | undefined {
  if (typeof name !== 'string' || !name.trim()) return undefined;
  const found = findItemMatch(bills.map((b) => ({ ...b, item: b.name })), name.replace(/^(a|o|conta de|conta da|conta do)\s+/i, ''));
  return found ? bills.find((b) => b.id === found.id) : undefined;
}

type PaymentRow = { id: string; bill_id: string; due_date: string; paid_at: string | null };

export async function billsContext(familyId: string): Promise<string[]> {
  const bills = await activeBills(familyId);
  return bills.map((b) => {
    const rule = b.recurrence === 'mensal' ? `mensal dia ${b.due_day}` : b.recurrence === 'anual' ? `anual ${b.due_day}/${b.due_month}` : `única ${b.due_date}`;
    return `- ${b.name}${b.amount_cents ? ` (${formatBRL(b.amount_cents)})` : ''} | ${rule}`;
  });
}

export async function executeBillTool(name: string, input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const now = new Date();
  const today = localYmd(now);
  const familyId = ctx.member.family_id;

  switch (name) {
    case 'cadastrar_conta': {
      const nome = typeof input.nome === 'string' ? input.nome.trim() : '';
      const rec = input.recorrencia;
      if (!nome) return { ok: false, resultado: 'Falta o nome da conta.' };
      if (rec !== 'mensal' && rec !== 'anual' && rec !== 'unica') return { ok: false, resultado: 'Recorrência inválida.' };
      const day = Number(input.dia_vencimento);
      const month = Number(input.mes_vencimento);
      const date = typeof input.data_vencimento === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.data_vencimento) ? input.data_vencimento : null;
      if ((rec === 'mensal' || rec === 'anual') && !(day >= 1 && day <= 31)) return { ok: false, resultado: 'Falta o dia do vencimento. Pergunte.' };
      if (rec === 'anual' && !(month >= 1 && month <= 12)) return { ok: false, resultado: 'Falta o mês do vencimento. Pergunte.' };
      if (rec === 'unica' && !date) return { ok: false, resultado: 'Falta a data do vencimento. Pergunte.' };
      if (rec === 'unica' && date! < today) return { ok: false, resultado: 'Essa data já passou. Confirme com a pessoa.' };

      const existing = findBill(await activeBills(familyId), nome);
      if (existing && existing.name.toLowerCase() === nome.toLowerCase()) {
        return { ok: false, resultado: `Já existe a conta "${existing.name}". Pergunte se quer alterar ou se é outra conta (outro nome).` };
      }
      const remind = Array.isArray(input.lembrar_dias_antes)
        ? input.lembrar_dias_antes.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 30)
        : [];
      const amount = typeof input.valor === 'number' || typeof input.valor === 'string' ? toCents(input.valor) : null;

      const { data, error } = await db
        .from('bills')
        .insert({
          family_id: familyId,
          created_by: ctx.member.id,
          name: nome.charAt(0).toUpperCase() + nome.slice(1),
          amount_cents: amount,
          recurrence: rec,
          due_day: rec === 'unica' ? null : day,
          due_month: rec === 'anual' ? month : null,
          due_date: rec === 'unica' ? date : null,
          remind_days_before: remind.length ? remind : [3, 0],
          active: true,
        })
        .select(BILL_COLS)
        .single();
      if (error) throw error;
      const bill = data as BillRow;
      const dues = await ensureBillOccurrences(bill, now);
      ctx.replies.push(billCreatedText({ ...bill, remind_days_before: bill.remind_days_before ?? [3, 0] }, dues[0] ?? null, now));
      return { ok: true, resultado: `Conta ${bill.name} cadastrada. A confirmação já foi enviada.` };
    }

    case 'listar_contas': {
      const periodo = input.periodo === 'este_mes' || input.periodo === 'vencidas' ? input.periodo : 'proximos_30_dias';
      const bills = await activeBills(familyId);
      if (!bills.length) {
        ctx.replies.push('🧾 Nenhuma conta cadastrada ainda. Ex.: _"internet vence todo dia 15, 120 reais"_.');
        return { ok: true, resultado: 'Sem contas. A confirmação já foi enviada.' };
      }
      // garante que as ocorrências do período existem (ex.: conta cadastrada há pouco)
      for (const b of bills) await ensureBillOccurrences(b, now);

      let q = db.from('bill_payments').select('id, bill_id, due_date, paid_at').in('bill_id', bills.map((b) => b.id));
      let title = 'dos próximos 30 dias';
      if (periodo === 'vencidas') {
        q = q.lt('due_date', today).is('paid_at', null);
        title = 'vencidas';
      } else if (periodo === 'este_mes') {
        const y = Number(today.slice(0, 4));
        const m = Number(today.slice(5, 7));
        const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
        q = q.gte('due_date', `${today.slice(0, 7)}-01`).lt('due_date', next);
        title = 'deste mês';
      } else {
        // próximos 30 dias + vencidas ainda em aberto
        q = q.lte('due_date', addDays(today, 30));
      }
      const { data, error } = await q.order('due_date', { ascending: true });
      if (error) throw error;
      const rows = ((data ?? []) as PaymentRow[]).filter((p) => periodo !== 'proximos_30_dias' || !p.paid_at || p.due_date >= today);
      const items: PaymentView[] = rows.map((p) => {
        const b = bills.find((x) => x.id === p.bill_id)!;
        return { name: b.name, amount_cents: b.amount_cents, due_date: p.due_date, paid_at: p.paid_at ? new Date(p.paid_at) : null };
      });
      ctx.replies.push(billListText(items, now, title));
      return { ok: true, resultado: `${items.length} contas listadas. A confirmação já foi enviada.` };
    }

    case 'pagar_conta': {
      const bills = await activeBills(familyId);
      const bill = findBill(bills, input.conta);
      if (!bill) {
        return { ok: false, resultado: `Não achei a conta "${String(input.conta)}". Contas cadastradas: ${bills.map((b) => b.name).join(', ') || 'nenhuma'}.` };
      }
      await ensureBillOccurrences(bill, now);
      // a ocorrência em aberto mais antiga, até 40 dias à frente
      const { data: pays, error } = await db
        .from('bill_payments')
        .select('id, bill_id, due_date, paid_at')
        .eq('bill_id', bill.id)
        .is('paid_at', null)
        .lte('due_date', addDays(today, 40))
        .order('due_date', { ascending: true })
        .limit(1);
      if (error) throw error;
      const pay = (pays ?? [])[0] as PaymentRow | undefined;
      if (!pay) return { ok: false, resultado: `Não há vencimento de ${bill.name} em aberto. Talvez já esteja paga.` };

      const paidCents = typeof input.valor_pago === 'number' || typeof input.valor_pago === 'string' ? toCents(input.valor_pago) : bill.amount_cents;
      let expenseId: string | null = null;
      let expenseText = '';
      if (input.registrar_como_gasto !== false && paidCents) {
        const category = matchCategory(ctx.categories, 'Contas da casa') ?? matchCategory(ctx.categories, 'Moradia') ?? matchCategory(ctx.categories, 'Outros');
        const { data: exp, error: eErr } = await db
          .from('expenses')
          .insert({
            family_id: familyId, member_id: ctx.member.id, category_id: category?.id ?? null, amount_cents: paidCents,
            description: bill.name, spent_at: now.toISOString(), source: ctx.source === 'imagem' ? 'imagem' : ctx.source,
            receipt_path: ctx.receiptPath, status: 'confirmado',
          })
          .select('id')
          .single();
        if (eErr) throw eErr;
        expenseId = (exp as { id: string }).id;
        expenseText = '\n\n' + confirmationText({
          amount_cents: paidCents, categoryName: category?.name ?? 'Outros', categoryEmoji: category?.emoji,
          description: bill.name, spent_at: now, memberName: ctx.member.name,
        }).replace('Responda *corrigir* se algo estiver errado.', '').trim();
      }
      const { error: uErr } = await db
        .from('bill_payments')
        .update({ paid_at: now.toISOString(), paid_by: ctx.member.id, expense_id: expenseId })
        .eq('id', pay.id);
      if (uErr) throw uErr;
      await cancelPendingReminders([pay.id], ['conta', 'conta_vencida']);

      const due = `${pay.due_date.slice(8, 10)}/${pay.due_date.slice(5, 7)}`;
      const noValue = input.registrar_como_gasto !== false && !paidCents ? '\n_Não lancei nos gastos porque não sei o valor. Me diga: "a luz deu 187"._' : '';
      ctx.replies.push(`✅ *${bill.name}* paga (vencimento ${due}). Lembretes dessa conta cancelados.${expenseText}${noValue}`);
      return { ok: true, resultado: 'Conta paga. A confirmação já foi enviada.' };
    }

    case 'excluir_conta': {
      const bills = await activeBills(familyId);
      const bill = findBill(bills, input.conta);
      if (!bill) return { ok: false, resultado: `Não achei a conta "${String(input.conta)}".` };
      if (input.confirmado_pelo_usuario !== true) {
        return { ok: false, resultado: `Ainda não confirmado. Pergunte: "Paro de acompanhar a conta ${bill.name}?"` };
      }
      const { data: open } = await db.from('bill_payments').select('id').eq('bill_id', bill.id).is('paid_at', null);
      const openIds = (open ?? []).map((p: { id: string }) => p.id);
      await cancelPendingReminders(openIds, ['conta', 'conta_vencida']);
      if (openIds.length) await db.from('bill_payments').delete().in('id', openIds);
      const { error } = await db.from('bills').update({ active: false }).eq('id', bill.id);
      if (error) throw error;
      ctx.replies.push(`🗑️ Não vou mais acompanhar a conta *${bill.name}*. O histórico de pagamentos fica guardado.`);
      return { ok: true, resultado: 'Conta excluída. A confirmação já foi enviada.' };
    }

    default:
      return { ok: false, resultado: `Ferramenta desconhecida: ${name}` };
  }
}
