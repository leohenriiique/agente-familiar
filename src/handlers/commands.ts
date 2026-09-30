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

  // "adiciona Ana 34 99999-9999"  |  "adicionar admin João +55 34 98888-7777"
  const add = text.match(/^\s*adiciona(?:r)?\s+(admin\s+)?(.+?)\s+([+()\d][\d\s()+.-]{8,})\s*$/i);
  if (add) {
    const phone = normalizeBrPhone(add[3]!);
    const name = add[2]!.trim();
    if (!phone) return { kind: 'invalid', reason: `Não reconheci o número "${add[3]!.trim()}". Use DDD + número, ex.: 34 99999-9999.` };
    if (!name) return { kind: 'invalid', reason: 'Faltou o nome. Ex.: adiciona Ana 34 99999-9999' };
    return { kind: 'add_member', name, phone, admin: Boolean(add[1]) };
  }
  if (/^adiciona(r)?\b/.test(t)) {
    return { kind: 'invalid', reason: 'Formato: adiciona <nome> <telefone com DDD>. Ex.: adiciona Ana 34 99999-9999' };
  }

  const rem = text.match(/^\s*remov(?:e|er)\s+(.+?)\s*$/i);
  if (rem) return { kind: 'remove_member', target: rem[1]! };

  return { kind: 'unknown' };
}

export const HELP_TEXT = [
  '*Assistente da família* 🏠',
  '',
  'Por enquanto eu entendo:',
  '• *oi* — testar se estou funcionando',
  '• *membros* — quem está cadastrado',
  '',
  'Só para admin:',
  '• *adiciona Ana 34 99999-9999*',
  '• *adiciona admin João 34 98888-7777*',
  '• *remove Ana* (ou o número)',
  '',
  'Em breve: gastos, lista de compras, agenda e contas a pagar.',
].join('\n');
