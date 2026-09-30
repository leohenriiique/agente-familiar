import { db } from '../db/supabase.js';
import { getMediaBase64 } from '../whatsapp/evolution.js';
import type { IncomingMessage } from '../whatsapp/parse.js';
import { baseMime, extFromMime } from './mime.js';

export type Media = { buffer: Buffer; base64: string; mimetype: string };

const BUCKET = 'receipts';

/** Usa o base64 que veio no webhook; se não veio, pede para a Evolution. */
export async function loadMedia(msg: IncomingMessage, fallbackMime: string): Promise<Media> {
  let base64 = msg.mediaBase64;
  let mimetype = msg.mimetype;
  if (!base64) {
    const res = await getMediaBase64(msg.waMessageId);
    base64 = res.base64;
    mimetype = mimetype ?? res.mimetype;
  }
  // alguns payloads vêm como data URL
  base64 = base64.replace(/^data:[^;]+;base64,/, '');
  return { base64, buffer: Buffer.from(base64, 'base64'), mimetype: baseMime(mimetype, fallbackMime) };
}

/** Guarda no bucket privado e devolve o caminho (ex.: "familyId/imagem/ABC123.jpg"). */
export async function storeMedia(
  familyId: string,
  kind: 'imagem' | 'audio' | 'documento',
  waMessageId: string,
  media: Media,
): Promise<string | null> {
  const path = `${familyId}/${kind}/${waMessageId}.${extFromMime(media.mimetype)}`;
  const { error } = await db.storage.from(BUCKET).upload(path, media.buffer, {
    contentType: media.mimetype,
    upsert: true,
  });
  if (error) {
    // Guardar é desejável, não obrigatório: o gasto segue mesmo sem o arquivo
    console.error('Falha ao guardar mídia no Storage', error);
    return null;
  }
  return path;
}
