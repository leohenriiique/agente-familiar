import { jidToPhone } from './phone.js';

export type IncomingType = 'text' | 'audio' | 'image' | 'document' | 'other';

export type IncomingMessage = {
  waMessageId: string;
  remoteJid: string;       // conversa (privado ou grupo) — é para onde respondemos
  senderPhone: string;     // quem mandou, só dígitos
  pushName?: string;
  isGroup: boolean;
  type: IncomingType;
  text?: string;           // texto ou legenda
  mediaBase64?: string;    // presente quando webhook_base64 = true
  mimetype?: string;
  timestamp: Date;
};

type AnyObj = Record<string, any>;

/**
 * Converte o payload do evento MESSAGES_UPSERT da Evolution API v2
 * em uma mensagem interna. Retorna null para o que deve ser ignorado
 * (mensagens próprias, status, reações, eventos de outro tipo).
 */
export function parseEvolutionWebhook(body: AnyObj): IncomingMessage | null {
  const event = String(body?.event ?? '').toLowerCase().replace(/_/g, '.');
  if (event !== 'messages.upsert') return null;

  // A v2 costuma mandar data como objeto; algumas versões mandam array
  const data: AnyObj | undefined = Array.isArray(body.data) ? body.data[0] : body.data;
  if (!data?.key || !data?.message) return null;

  const key = data.key as AnyObj;
  if (key.fromMe) return null;

  const remoteJid: string = key.remoteJid ?? '';
  if (!remoteJid || remoteJid === 'status@broadcast') return null;

  const isGroup = remoteJid.endsWith('@g.us');

  // Quem enviou: no grupo é o participant; no privado é o remoteJid.
  // Contas novas podem vir como "@lid" — nesse caso a Evolution manda o número real
  // em senderPn / remoteJidAlt / participantAlt.
  let senderJid: string = isGroup ? (key.participant ?? data.participant ?? '') : remoteJid;
  if (senderJid.endsWith('@lid')) {
    senderJid = key.senderPn ?? key.participantAlt ?? key.remoteJidAlt ?? data.senderPn ?? senderJid;
  }
  const senderPhone = jidToPhone(senderJid);
  if (!senderPhone || senderJid.endsWith('@lid')) return null;

  const m = data.message as AnyObj;
  let type: IncomingType = 'other';
  let text: string | undefined;
  let mimetype: string | undefined;

  if (typeof m.conversation === 'string') {
    type = 'text';
    text = m.conversation;
  } else if (m.extendedTextMessage?.text) {
    type = 'text';
    text = m.extendedTextMessage.text;
  } else if (m.audioMessage) {
    type = 'audio';
    mimetype = m.audioMessage.mimetype;
  } else if (m.imageMessage) {
    type = 'image';
    text = m.imageMessage.caption || undefined;
    mimetype = m.imageMessage.mimetype;
  } else if (m.documentMessage || m.documentWithCaptionMessage) {
    const doc = m.documentMessage ?? m.documentWithCaptionMessage?.message?.documentMessage;
    type = 'document';
    text = doc?.caption || undefined;
    mimetype = doc?.mimetype;
  } else if (m.reactionMessage || m.protocolMessage) {
    return null;
  }

  const ts = Number(data.messageTimestamp);
  return {
    waMessageId: key.id,
    remoteJid,
    senderPhone,
    pushName: data.pushName,
    isGroup,
    type,
    text: text?.trim(),
    mediaBase64: typeof m.base64 === 'string' ? m.base64 : undefined,
    mimetype,
    timestamp: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : new Date(),
  };
}
