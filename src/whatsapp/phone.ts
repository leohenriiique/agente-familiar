/**
 * Telefones são guardados só com dígitos e DDI: 5534999999999.
 * O WhatsApp às vezes entrega números brasileiros sem o 9 extra do celular
 * (553499999999), então a busca considera as duas formas.
 */

export function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

/** "5534999999999@s.whatsapp.net" → "5534999999999" */
export function jidToPhone(jid: string): string {
  return onlyDigits(jid.split('@')[0]?.split(':')[0] ?? '');
}

/** Normaliza o que o usuário digita ("(34) 99999-9999", "+55 34 9...") para 55DDXXXXXXXXX. */
export function normalizeBrPhone(input: string): string | null {
  let digits = onlyDigits(input);
  if (digits.startsWith('0')) digits = digits.replace(/^0+/, '');
  if (digits.length === 10 || digits.length === 11) digits = '55' + digits;
  if (!digits.startsWith('55')) return digits.length >= 10 ? digits : null;
  if (digits.length === 12) {
    // 55 + DDD + 8 dígitos: celular sem o 9 → acrescenta
    const local = digits.slice(4);
    if (/^[6-9]/.test(local)) digits = digits.slice(0, 4) + '9' + local;
  }
  return digits.length === 13 || digits.length === 12 ? digits : null;
}

/** Variantes para busca: com e sem o 9 do celular. */
export function phoneVariants(phone: string): string[] {
  const d = onlyDigits(phone);
  const out = new Set([d]);
  if (d.startsWith('55') && d.length === 13 && d[4] === '9') out.add(d.slice(0, 4) + d.slice(5));
  if (d.startsWith('55') && d.length === 12 && /^[6-9]/.test(d.slice(4))) {
    out.add(d.slice(0, 4) + '9' + d.slice(4));
  }
  return [...out];
}
