import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { config } from './config.js';
import { handleIncoming } from './handlers/incoming.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { parseEvolutionWebhook } from './whatsapp/parse.js';

const app = Fastify({ logger: { level: 'info' }, bodyLimit: 25 * 1024 * 1024 }); // mídia em base64

function tokenOk(received: unknown): boolean {
  if (typeof received !== 'string') return false;
  const a = Buffer.from(received);
  const b = Buffer.from(config.WEBHOOK_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Fila simples em memória: mensagens do mesmo remetente são processadas em ordem,
 * remetentes diferentes em paralelo. Suficiente para uma família; se crescer,
 * trocar por uma fila persistente (pg-boss no próprio Supabase).
 */
const chains = new Map<string, Promise<void>>();
function enqueue(key: string, job: () => Promise<void>) {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev
    .then(job)
    .catch((err) => app.log.error({ err, key }, 'Erro ao processar mensagem'))
    .finally(() => {
      if (chains.get(key) === next) chains.delete(key);
    });
  chains.set(key, next);
}

app.get('/health', async () => ({ ok: true }));

app.post('/webhook/evolution', async (req, reply) => {
  const token = (req.query as Record<string, unknown>)?.token ?? req.headers['x-webhook-token'];
  if (!tokenOk(token)) return reply.code(401).send({ error: 'unauthorized' });

  const msg = parseEvolutionWebhook(req.body as Record<string, unknown>);
  if (msg) {
    app.log.info({ from: msg.senderPhone, type: msg.type, id: msg.waMessageId }, 'mensagem recebida');
    enqueue(msg.senderPhone, () => handleIncoming(msg));
  }
  // Responde já: a Evolution reenvia se o webhook demorar
  return reply.code(200).send({ received: true });
});

app
  .listen({ port: config.PORT, host: '0.0.0.0' })
  .then(() => {
    app.log.info(`Agente familiar ouvindo na porta ${config.PORT}`);
    startScheduler((msg) => app.log.info(msg));
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    app.log.info('Encerrando: aguardando mensagens em processamento…');
    stopScheduler();
    await Promise.allSettled([...chains.values()]);
    await app.close();
    process.exit(0);
  });
}
