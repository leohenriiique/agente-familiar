import { db } from '../db/supabase.js';
import type { IncomingMessage } from '../whatsapp/parse.js';

/**
 * Grava a mensagem recebida. Retorna false se ela já existia —
 * é assim que evitamos processar duas vezes quando a Evolution reenvia.
 */
export async function logIncoming(
  msg: IncomingMessage,
  member: { id: string; family_id: string } | null,
): Promise<boolean> {
  const { error } = await db.from('messages').insert({
    family_id: member?.family_id ?? null,
    member_id: member?.id ?? null,
    direction: 'in',
    type: msg.type,
    // De números não cadastrados guardamos só o registro, não o conteúdo
    text: member ? (msg.text ?? null) : null,
    wa_message_id: msg.waMessageId,
    remote_jid: msg.remoteJid,
    created_at: msg.timestamp.toISOString(),
  });
  if (error?.code === '23505') return false; // unique_violation em wa_message_id
  if (error) throw error;
  return true;
}

export async function logOutgoing(
  to: string,
  text: string,
  member: { id: string; family_id: string } | null,
  waMessageId?: string,
) {
  const { error } = await db.from('messages').insert({
    family_id: member?.family_id ?? null,
    member_id: member?.id ?? null,
    direction: 'out',
    type: 'text',
    text,
    wa_message_id: waMessageId ?? null,
    remote_jid: to,
  });
  if (error) console.error('Falha ao registrar mensagem enviada', error);
}
