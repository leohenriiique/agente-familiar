import { config } from '../config.js';

const base = config.EVOLUTION_URL.replace(/\/$/, '');
const instance = encodeURIComponent(config.EVOLUTION_INSTANCE);

async function call<T = unknown>(path: string, body: unknown, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: config.EVOLUTION_API_KEY },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return (await res.json().catch(() => ({}))) as T;
      const detail = await res.text();
      // Erro do cliente (número inválido, payload errado): não adianta repetir
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw new Error(`Evolution ${path} ${res.status}: ${detail}`);
      }
      lastError = new Error(`Evolution ${path} ${res.status}: ${detail}`);
    } catch (err) {
      lastError = err;
      if (err instanceof Error && /Evolution .* 4\d\d/.test(err.message) && !err.message.includes(' 429')) throw err;
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** i));
  }
  throw lastError;
}

/** `to` pode ser um número (5534999999999) ou um JID completo (grupo ou privado). */
export async function sendText(to: string, text: string, quotedId?: string) {
  return call<{ key?: { id?: string } }>(`/message/sendText/${instance}`, {
    number: to,
    text,
    ...(quotedId ? { quoted: { key: { id: quotedId } } } : {}),
  });
}

export async function sendImage(to: string, base64Png: string, caption?: string) {
  return call<{ key?: { id?: string } }>(`/message/sendMedia/${instance}`, {
    number: to,
    mediatype: 'image',
    mimetype: 'image/png',
    media: base64Png,
    fileName: 'relatorio.png',
    caption,
  });
}

/** Mostra "digitando…" por alguns segundos. Falha aqui nunca bloqueia a resposta. */
export async function sendTyping(to: string, ms = 3000) {
  try {
    await call(`/chat/sendPresence/${instance}`, { number: to, presence: 'composing', delay: ms }, 1);
  } catch {
    /* opcional */
  }
}

/**
 * Configura o webhook da instância. As versões 2.x da Evolution variam no nome
 * dos campos (webhookByEvents / webhook_by_events / byEvents), então mandamos
 * as três formas; a API ignora as que não conhece.
 */
export async function setWebhook(url: string) {
  const webhook = {
    enabled: true,
    url,
    events: ['MESSAGES_UPSERT'],
    webhookByEvents: false,
    webhookBase64: true,
    webhook_by_events: false,
    webhook_base64: true,
    byEvents: false,
    base64: true,
  };
  return call(`/webhook/set/${instance}`, { webhook, ...webhook }, 1);
}
