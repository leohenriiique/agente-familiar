import { normalizeBrPhone } from '../whatsapp/phone.js';

export type Command =
  | { kind: 'help' }
  | { kind: 'greeting' }
  | { kind: 'list_members' }
  | { kind: 'add_member'; name: string; phone: string; admin: boolean }
  | { kind: 'remove_member'; target: string }
  | { kind: 'invalid'; reason: string }
  | { kind: 'unknown' };

const strip = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/**
 * Comandos fixos da fase 1. A partir da fase 2 tudo que não for comando
 * vai para o agente (Claude), mas estes continuam determinísticos de propósito:
 * mexer em quem tem acesso não deve depender da interpretação de um modelo.
 */
export function parseCommand(raw: string | undefined): Command {
  const text = (raw ?? '').trim();
  const t = strip(text);
  if (!t) return { kind: 'unknown' };

  if (/^(ajuda|menu|comandos|help|\/ajuda)$/.test(t)) return { kind: 'help' };
  if (/^(oi+|ola|bom dia|boa tarde|boa noite|e ai|opa|hey)[!. ]*$/.test(t)) return { kind: 'greeting' };
  if (/^(membros|quem (esta|ta) cadastrado|lista de membros)\??$/.test(t)) return { kind: 'list_members' };

  // Frases sobre dinheiro, gastos ou lista de compras vão para o agente, mesmo começando com "adiciona" ou "remove"
  // ("adiciona gasto de 50", "remove o último gasto", "adiciona 35,90 de farmácia").
  if (/\b(gasto|gastos|compra|compras|comprar|lista|despesa|conta|contas|compromisso|agenda|reais|real|r\$)\b|\d+,\d{2}\b|\br\$/i.test(t)) return { kind: 'unknown' };

  // "adiciona Ana 34 99999-9999"  |  "adicionar admin João +55 34 98888-7777"
  const add = text.match(/^\s*adiciona(?:r)?\s+(admin\s+)?(.+?)\s+([+()\d][\d\s()+.-]{8,})\s*$/i);
  if (add) {
    const phone = normalizeBrPhone(add[3]!);
    const name = add[2]!.trim();
    if (!phone) return { kind: 'invalid', reason: `Não reconheci o número "${add[3]!.trim()}". Use DDD + número, ex.: 34 99999-9999.` };
    if (!name) return { kind: 'invalid', reason: 'Faltou o nome. Ex.: adiciona Ana 34 99999-9999' };
    return { kind: 'add_member', name, phone, admin: Boolean(add[1]) };
  }
  // "adiciona Ana" (sem número) → explica o formato; com números, provavelmente é gasto → agente
  if (/^adiciona(r)?\b/.test(t) && !/\d/.test(t)) {
    return { kind: 'invalid', reason: 'Formato: adiciona <nome> <telefone com DDD>. Ex.: adiciona Ana 34 99999-9999' };
  }

  const rem = text.match(/^\s*remov(?:e|er)\s+(.+?)\s*$/i);
  if (rem) return { kind: 'remove_member', target: rem[1]! };

  return { kind: 'unknown' };
}

export const HELP_TEXT = [
  '*Assistente da família* 🏠',
  '',
  '*Gastos* — escreva, mande áudio ou foto do cupom:',
  '• _gastei 50 de gasolina_',
  '• _almoço 38,90 no crédito ontem_',
  '• _na verdade foi 45_  /  _muda para Saúde_',
  '• _apaga o último gasto_',
  '',
  '*Lista de compras:*',
  '• _precisa comprar macarrão e detergente_',
  '• _estou no supermercado, precisa algo?_',
  '• _peguei o macarrão_  /  _comprei tudo_',
  '• _tira o detergente da lista_',
  '',
  '*Agenda:*',
  '• _dentista da Ana quinta às 14h_',
  '• _o que temos amanhã?_',
  '',
  '*Contas a pagar:*',
  '• _internet vence todo dia 15, 120 reais_',
  '• _quais contas vencem esse mês?_',
  '• _paguei a internet_',
  '',
  '• *membros* — quem está cadastrado',
  '',
  'Só para admin:',
  '• *adiciona Ana 34 99999-9999*',
  '• *adiciona admin João 34 98888-7777*',
  '• *remove Ana* (ou o número)',
  '',
  'Em breve: relatórios de gastos com gráfico.',
].join('\n');
