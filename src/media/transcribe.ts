import { config } from '../config.js';
import { extFromMime } from './mime.js';

/**
 * Transcreve um áudio do WhatsApp (ogg/opus) com a API de transcrição da OpenAI.
 * Retorna o texto já sem espaços nas pontas; string vazia se não houver fala.
 */
export async function transcribe(buffer: Buffer, mimetype: string): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)], { type: mimetype }), `audio.${extFromMime(mimetype)}`);
  form.append('model', config.OPENAI_TRANSCRIBE_MODEL);
  form.append('language', 'pt');
  // Ajuda a acertar valores e termos comuns de gastos
  form.append('prompt', 'Gastos da família: reais, R$, mercado, farmácia, gasolina, Pix, cartão, débito, crédito.');

  let lastError: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}` },
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) {
        const data = (await res.json()) as { text?: string };
        return (data.text ?? '').trim();
      }
      const detail = await res.text();
      lastError = new Error(`OpenAI transcrição ${res.status}: ${detail}`);
      if (res.status < 500 && res.status !== 429) break; // chave inválida, sem crédito etc.
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
  }
  throw lastError;
}
