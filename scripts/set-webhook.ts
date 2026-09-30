/**
 * Aponta o webhook da instância da Evolution para este backend.
 *
 *   npm run setup:webhook
 */
import { config } from '../src/config.js';
import { setWebhook } from '../src/whatsapp/evolution.js';

if (!config.PUBLIC_URL) {
  console.error('Defina PUBLIC_URL no .env (a URL pública deste backend).');
  process.exit(1);
}

const url = `${config.PUBLIC_URL.replace(/\/$/, '')}/webhook/evolution?token=${encodeURIComponent(config.WEBHOOK_TOKEN)}`;
const res = await setWebhook(url);
console.log('✅ Webhook configurado:', url.replace(config.WEBHOOK_TOKEN, '***'));
console.log(JSON.stringify(res, null, 2));
