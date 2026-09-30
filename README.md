# Agente Familiar — Fases 1 a 4

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

## Fase 2 — gastos por texto, áudio e foto

| Mensagem | O que acontece |
| --- | --- |
| _gastei 50 de gasolina ontem_ | Registra R$ 50,00 em Combustível, data de ontem, e confirma |
| 🎙️ áudio | Transcreve, mostra o que entendeu e registra |
| 📸 foto do cupom | Guarda a foto e lê total, loja, data e pagamento; leitura incerta fica *pendente* até um "sim" |
| _na verdade foi 45_ / _muda para Saúde_ | Corrige o último gasto |
| _apaga o último gasto_ | Pergunta antes e só apaga depois do "sim" |
| _50 de gasolina e 30 na padaria_ | Registra dois gastos |

Cada parte liga sozinha quando a chave existe no ambiente:

| Chave | Liga |
| --- | --- |
| `OPENAI_API_KEY` | Transcrição de áudios |
| `ANTHROPIC_API_KEY` | Entender gastos e ler cupons |

Sem a chave do Claude, o agente continua respondendo: transcreve áudios, guarda fotos e avisa que registrar gastos ainda não está ativo. Fotos e áudios ficam no bucket privado `receipts`, em `<família>/<imagem|audio>/<id da mensagem>`.

Testes: `npm test` (funções puras) e `npm run test:sim` (conversas completas com banco e APIs falsos).

## Fase 3 — lista de compras

| Mensagem | O que acontece |
| --- | --- |
| _precisa comprar macarrão, detergente e dipirona_ | Anota cada item no local certo (supermercado, farmácia…) e na seção (mercearia, limpeza…) |
| _anota 2 pacotes de macarrão_ | Item que já está na lista não duplica: atualiza a quantidade |
| _estou no supermercado, precisa algo?_ | Mostra só o supermercado, agrupado por seção, com quem anotou |
| _o que tem na lista?_ | Mostra todos os locais |
| _peguei o macarrão_ | Dá baixa e diz quantos itens faltam |
| _comprei tudo_ | Pergunta antes e só dá baixa depois do "sim" |
| _tira o detergente da lista_ | Remove sem marcar como comprado |

A lista é da família inteira: o que um anota, todos veem. Requer a migration `0002_shopping_section.sql` (coluna `section`).

## Fase 4 — agenda e contas a pagar

| Mensagem | O que acontece |
| --- | --- |
| _dentista da Ana quinta às 14h_ | Agenda com aviso 1 dia e 1 hora antes, para você e a Ana |
| _me lembra 30 min antes_ | Troca os avisos daquele compromisso |
| _o que temos amanhã?_ / _agenda da semana_ | Lista por dia, com horário, local e quem vai |
| _o dentista passou para as 15h_ | Atualiza e refaz os avisos |
| _cancela o dentista_ | Pergunta antes, depois apaga compromisso e avisos |
| _internet vence todo dia 15, 120 reais_ | Conta mensal com lembrete 3 dias antes e no dia (9h) |
| _IPVA todo ano dia 20 de março_ / _boleto dia 05/11_ | Conta anual / única |
| _quais contas vencem?_ / _tem conta atrasada?_ | Lista com status: ✅ paga, 🟡 vence em até 3 dias, 🔴 vencida |
| _paguei a internet_ | Marca paga, lança nos gastos (Contas da casa) e cancela os avisos seguintes |

**Agendador:** roda dentro do backend (`src/scheduler.ts`). A cada minuto envia os lembretes vencidos; de hora em hora gera os vencimentos dos próximos 40 dias. Conta não paga recebe aviso de *vencida* no dia seguinte, às 9h. Lembretes de conta vão para os admins e para quem cadastrou; de compromisso, para os participantes. Se o servidor ficar fora do ar, os lembretes atrasados até 6 h saem quando ele voltar; os mais antigos são descartados. Requer a migration `0003_bills_schedule.sql`.

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

## Deploy no Easypanel (mesma VPS da Evolution)

1. Suba este código para um repositório **privado** no GitHub (o `.env` fica de fora pelo `.gitignore`).
2. No Easypanel: **Configurações → GitHub**, cole um token do GitHub com acesso de leitura ao repositório.
3. No projeto `agente`: **+ Serviço → App**, nome **`backend`**.
4. Aba **Fonte**: GitHub → seu usuário, repositório e branch `main`.
5. Aba **Build**: **Dockerfile** (caminho `Dockerfile`).
6. Aba **Ambiente**: cole o conteúdo do `.env`, com `PUBLIC_URL=http://agente_backend:3000` e `EVOLUTION_URL=http://agente_evolution-api:8080`.
7. **Implantar**. Não precisa de domínio: a Evolution chama o backend pela rede interna.
8. Com o serviço verde, abra o **Console** do serviço `backend` e rode:
   ```bash
   node dist/scripts/setup-family.js "Família Silva" "Leo" "34 99999-9999"
   node dist/scripts/set-webhook.js
   ```
9. Mande `oi` para o número do agente.

Cada `git push` na `main` pode reimplantar sozinho: ative **Auto Deploy** na aba Fonte.

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

Fase 5 — relatórios: gastos por categoria e período com gráfico, comparação com o período anterior e resumos automáticos (semanal e mensal).
