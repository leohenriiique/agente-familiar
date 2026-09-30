# Agente Familiar — Fase 1

Backend do assistente da família no WhatsApp. Esta fase entrega a base: Evolution API conectada, webhook, cadastro de família e membros, log de mensagens e resposta **só para números cadastrados**.

## O que funciona

| Mensagem | Quem | Resposta |
| --- | --- | --- |
| `oi`, `olá`, `bom dia` | membro | Confirma que o agente está no ar |
| `ajuda` | membro | Lista de comandos |
| `membros` | membro | Quem está cadastrado |
| `adiciona Ana 34 99999-9999` | admin | Cadastra e manda boas-vindas para a Ana |
| `adiciona admin João 34 98888-7777` | admin | Cadastra como admin |
| `remove Ana` ou `remove 34 99999-9999` | admin | Desativa (histórico fica guardado) |
| áudio, foto, documento | membro | Avisa que chega na fase 2 |
| qualquer coisa | número desconhecido | Um aviso a cada 24 h, nada mais |

Mensagens repetidas pela Evolution são descartadas pelo `wa_message_id`. Mensagens do mesmo remetente são processadas em ordem.

## Como subir

**1. Banco (Supabase)**
Rode `supabase/migrations/0001_init.sql` no SQL Editor do projeto (ou `supabase db push` com a CLI). Ele já cria todas as tabelas das próximas fases, liga RLS e cria o bucket privado `receipts`.

**2. Variáveis**
```bash
cp .env.example .env   # preencha tudo
npm install
```
Gere um `WEBHOOK_TOKEN` longo: `openssl rand -hex 24`.

**3. Família e primeiro admin**
```bash
npm run setup:familia -- "Família Silva" "Leo" "34 99999-9999"
```

**4. Servidor**
```bash
npm run dev           # desenvolvimento
npm run build && npm start   # produção
```
Precisa de uma URL pública HTTPS (VPS com Caddy/Nginx, Railway, Render, Fly). Para testar local: `ngrok http 3000` e use a URL do ngrok em `PUBLIC_URL`.

**5. Webhook na Evolution**
```bash
npm run setup:webhook
```
Isso aponta `MESSAGES_UPSERT` da instância para `PUBLIC_URL/webhook/evolution?token=…`, com mídia em base64. Se preferir configurar pelo painel da Evolution, use a mesma URL, só o evento `MESSAGES_UPSERT` e "Webhook Base64" ligado.

**6. Teste**
Mande `oi` do seu WhatsApp para o número do agente. Depois `adiciona <alguém> <número>`.

## Checklist de "pronto" da fase 1

- [ ] `oi` de número cadastrado → resposta com o nome
- [ ] `oi` de número desconhecido → aviso único, nada gravado além do registro
- [ ] Mesma mensagem reenviada pela Evolution → processada uma vez só
- [ ] `adiciona` / `remove` só funcionam para admin
- [ ] Tabela `messages` com entrada e saída de cada conversa

## Estrutura

```
src/
  server.ts              Fastify: /health e /webhook/evolution (token + fila por remetente)
  config.ts              variáveis de ambiente validadas com zod
  db/supabase.ts         cliente service role
  whatsapp/
    parse.ts             payload MESSAGES_UPSERT → mensagem interna (texto, áudio, imagem, grupo, @lid)
    evolution.ts         sendText, sendImage, presença "digitando", setWebhook (com retry)
    phone.ts             normalização de telefone BR (com/sem o 9)
  handlers/
    incoming.ts          regras: grupo, desconhecido, dedupe, comandos
    commands.ts          parser dos comandos fixos
    members.ts           buscar/adicionar/desativar membros
    log.ts               tabela messages
scripts/                 setup da família e do webhook
supabase/migrations/     modelo de dados completo
tests/                   npm test — parser, telefones e comandos
```

## Observações

- **Número com e sem o 9:** o WhatsApp às vezes entrega celulares brasileiros sem o 9 extra. A busca de membros testa as duas formas.
- **Contas `@lid`:** em contas novas o remetente pode vir como `…@lid`; o parser usa o número real que a Evolution manda em `senderPn`/`remoteJidAlt`. Sem ele, a mensagem é ignorada (fica no log do servidor).
- **Grupo da família:** deixe `FAMILY_GROUP_JID` vazio na fase 1. Se preencher, o agente só responde no grupo quando a mensagem começa com "assistente".
- **Fila em memória:** suficiente para uma família. Se o agente virar produto, troque por `pg-boss` no próprio Postgres.

## Próxima fase

Fase 2 — gastos: `registrar_gasto`, `corrigir_gasto`, `excluir_gasto` com Claude (texto e imagem) e Whisper (áudio). Tudo que hoje cai em "ainda não sei fazer isso" passa a ir para o agente.
