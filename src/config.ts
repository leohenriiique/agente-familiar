import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  PUBLIC_URL: z.string().url().optional(),
  WEBHOOK_TOKEN: z.string().min(16, 'WEBHOOK_TOKEN precisa ter pelo menos 16 caracteres'),
  EVOLUTION_URL: z.string().url(),
  EVOLUTION_API_KEY: z.string().min(1),
  EVOLUTION_INSTANCE: z.string().min(1),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  FAMILY_GROUP_JID: z.string().optional().default(''),

  // Fase 2 — opcionais: cada parte liga sozinha quando a chave existe
  ANTHROPIC_API_KEY: z.string().optional().default(''),
  CLAUDE_MODEL: z.string().optional().default('claude-haiku-4-5-20251001'),
  OPENAI_API_KEY: z.string().optional().default(''),
  OPENAI_TRANSCRIBE_MODEL: z.string().optional().default('whisper-1'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Variáveis de ambiente inválidas:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

export const features = {
  agent: config.ANTHROPIC_API_KEY.length > 0,
  transcription: config.OPENAI_API_KEY.length > 0,
};
