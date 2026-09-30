/**
 * Funções puras de formatação e conversão usadas pelo agente.
 * Sem banco nem rede: são as partes testadas em tests/phase2.test.ts.
 */

export const TZ = 'America/Sao_Paulo';
// O Brasil não tem horário de verão desde 2019: São Paulo é sempre -03:00.
const SP_OFFSET = '-03:00';

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function formatBRL(cents: number): string {
  return brl.format(cents / 100).replace(/ /g, ' ');
}

/** 187.4 → 18740. Aceita número ou texto no formato brasileiro ("1.234,56"). */
export function toCents(value: number | string): number | null {
  let n: number;
  if (typeof value === 'number') n = value;
  else {
    const s = value.replace(/[R$\s]/g, '');
    // "1.234,56" → "1234.56";  "45,90" → "45.90";  "45.90" continua
    const normalized = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
    n = Number(normalized);
  }
  if (!Number.isFinite(n) || n <= 0) return null;
  const cents = Math.round(n * 100);
  return cents > 0 ? cents : null;
}

/** "29/09/2026 às 18:42" no horário de São Paulo. */
export function formatDateTime(date: Date): string {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')}/${get('month')}/${get('year')} às ${get('hour')}:${get('minute')}`;
}

/** Data e hora "de parede" em São Paulo, no formato que o modelo recebe: "2026-09-29T18:42". */
export function localIso(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

export function weekdayPt(date: Date): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, weekday: 'long' }).format(date);
}

/**
 * Converte a data/hora que o modelo devolve (horário de São Paulo) para Date.
 * - "2026-09-29T18:42" ou "2026-09-29T18:42:10" → aquele instante em SP
 * - "2026-09-29" (só a data, ex.: "ontem") → 12:00 daquele dia
 * - vazio ou inválido → `fallback`
 * Datas no futuro (mais de 10 minutos à frente) viram `fallback`: gasto não acontece no futuro.
 */
export function parseLocalDateTime(input: string | undefined | null, fallback: Date, now = new Date()): Date {
  if (!input) return fallback;
  const s = input.trim();
  let iso: string | null = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) iso = `${s}T12:00:00${SP_OFFSET}`;
  else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}$/.test(s)) iso = `${s.replace(' ', 'T')}:00${SP_OFFSET}`;
  else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}$/.test(s)) iso = `${s.replace(' ', 'T')}${SP_OFFSET}`;
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s)) iso = s;
  if (!iso) return fallback;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fallback;
  if (d.getTime() > now.getTime() + 10 * 60 * 1000) return fallback;
  return d;
}

export type ExpenseView = {
  amount_cents: number;
  categoryName: string;
  categoryEmoji?: string | null;
  merchant?: string | null;
  description?: string | null;
  spent_at: Date;
  memberName: string;
  payment_method?: string | null;
};

function expenseLines(e: ExpenseView): string[] {
  const where = [e.merchant, e.description].filter(Boolean).join(' — ');
  return [
    `💰 ${formatBRL(e.amount_cents)}`,
    `${e.categoryEmoji ?? '📦'} ${e.categoryName}${where ? ` — ${where}` : ''}`,
    `📅 ${formatDateTime(e.spent_at)}`,
    ...(e.payment_method ? [`💳 ${e.payment_method}`] : []),
    `👤 ${e.memberName}`,
  ];
}

export function confirmationText(e: ExpenseView): string {
  return ['✅ *Gasto registrado*', ...expenseLines(e), '', 'Responda *corrigir* se algo estiver errado.'].join('\n');
}

export function pendingText(e: ExpenseView): string {
  return ['⚠️ *Confere antes de eu salvar?*', ...expenseLines(e), '', 'Responda *sim* para confirmar ou me diga o que corrigir.'].join('\n');
}

export function updatedText(e: ExpenseView): string {
  return ['✏️ *Gasto atualizado*', ...expenseLines(e)].join('\n');
}

/** Remove a linha "🎙️ _"transcrição"_" que o sistema põe antes das respostas a áudio. */
export function stripHeard(text: string): string {
  return text.replace(/^\s*🎙️\s*_?"[^\n]*"_?\s*(\n+|$)/gmu, '').trim();
}

// Palavras de confirmação: se a ferramenta já mandou a confirmação, o modelo não precisa repetir
const RESTATES = /✅|🗑️|📝|📅|🧾|🔔|registrad|anotad|marcad|atualizad|apagad|removid|tirei|agendad|cadastrad|comprad[oa]s? |\bpag[ao]\b|vencimento/i;

/**
 * Limpa o texto final do modelo antes de ir para a pessoa:
 * - tira transcrições 🎙️ que o modelo copiou do histórico
 * - tira "OK"/"Pronto" do começo
 * - quando uma ferramenta já enviou a confirmação, descarta frases que só a repetem
 *   (mantém observações úteis, ex.: "A foto estava borrada no total.")
 */
export function cleanModelText(text: string, toolAlreadyReplied: boolean): string {
  let t = stripHeard(text);
  t = t.replace(/^(ok|okay|pronto|feito)\b[\s.!,:;-]*/i, '').trim();
  if (!t) return '';
  if (!toolAlreadyReplied) return t;
  // Pergunta à pessoa sempre passa
  if (t.includes('?')) return t;
  // Depois de uma confirmação do sistema, só passa uma observação curta de UMA linha,
  // sem formatação de cartão e sem repetir a ação ("✅ Compromisso agendado…", "Próximo vencimento…")
  const oneLine = !t.includes('\n');
  const noCard = !t.includes('*');
  if (oneLine && noCard && t.length >= 20 && t.length <= 160 && !RESTATES.test(t)) return t;
  return '';
}
