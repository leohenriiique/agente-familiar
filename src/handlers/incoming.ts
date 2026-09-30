import { runAgent } from '../agent/agent.js';
import { openItems } from '../agent/shopping.js';
import { config, features } from '../config.js';
import { db, type Member } from '../db/supabase.js';
import { sendText, sendTyping } from '../whatsapp/evolution.js';
import { isClaudeImage } from '../media/mime.js';
import { loadMedia, storeMedia } from '../media/storage.js';
import { transcribe } from '../media/transcribe.js';
import type { IncomingMessage } from '../whatsapp/parse.js';
import { normalizeBrPhone, phoneVariants } from '../whatsapp/phone.js';
import { HELP_TEXT, parseCommand } from './commands.js';
import { logIncoming, logOutgoing, updateIncoming } from './log.js';
import { addMember, deactivateMember, findActiveMemberByPhone, listMembers } from './members.js';

const GROUP_TRIGGER = /^\s*(assistente|@assistente)[,:!]?\s*/i;

async function reply(to: string, text: string, member: Member | null, quotedId?: string) {
  const res = await sendText(to, text, quotedId);
  await logOutgoing(to, text, member, res?.key?.id);
}

/** Avisa número desconhecido no máximo uma vez a cada 24 h, para não virar spam. */
async function shouldWarnStranger(jid: string): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count, error } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('remote_jid', jid)
    .eq('direction', 'out')
    .gte('created_at', since);
  if (error) return false;
  return (count ?? 0) === 0;
}

function formatPhone(p: string) {
  const m = p.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : p;
}

export async function handleIncoming(msg: IncomingMessage): Promise<void> {
  // Grupos: só o grupo da família configurado, e só quando chamam o assistente
  if (msg.isGroup) {
    if (!config.FAMILY_GROUP_JID || msg.remoteJid !== config.FAMILY_GROUP_JID) return;
    if (!msg.text || !GROUP_TRIGGER.test(msg.text)) return;
    msg = { ...msg, text: msg.text.replace(GROUP_TRIGGER, '') };
  }

  const member = await findActiveMemberByPhone(msg.senderPhone);
  const isNew = await logIncoming(msg, member);
  if (!isNew) return; // duplicada

  if (!member) {
    if (!msg.isGroup && (await shouldWarnStranger(msg.remoteJid))) {
      await reply(
        msg.remoteJid,
        'Olá! Este é o assistente de uma família e só atende números cadastrados. ' +
          'Se você faz parte dela, peça para o administrador te adicionar.',
        null,
      );
    }
    return;
  }

  await sendTyping(msg.remoteJid, 3000);

  try {
    if (msg.type === 'text') return await handleText(msg, member, msg.text ?? '', 'texto');
    if (msg.type === 'audio') return await handleAudio(msg, member);
    if (msg.type === 'image') return await handleImage(msg, member);
    return await reply(
      msg.remoteJid,
      `Recebi, ${member.name}! Por enquanto entendo texto, áudio e foto. Documentos (PDF) chegam em breve.`,
      member,
      msg.waMessageId,
    );
  } catch (err) {
    console.error('Erro ao processar mensagem', err);
    await reply(msg.remoteJid, 'Tive um problema para processar isso agora. 😕 Pode tentar de novo em instantes?', member);
  }
}

const AGENT_OFF =
  'Anotar gastos ainda não está ativo: falta ligar a inteligência do assistente (chave do Claude). Assim que estiver, é só mandar de novo. 🙂';

async function handleAudio(msg: IncomingMessage, member: Member) {
  if (!features.transcription) {
    return reply(msg.remoteJid, `Recebi seu áudio, ${member.name}! Ouvir áudios ainda não está ativo. Por enquanto, me mande por texto.`, member, msg.waMessageId);
  }
  const media = await loadMedia(msg, 'audio/ogg');
  // Itens da lista ajudam a transcrição a acertar nomes ("dipirona", não "de pirona")
  const hints = await openItems(member.family_id).then((l) => l.map((i) => i.item)).catch(() => []);
  const [text, path] = await Promise.all([
    transcribe(media.buffer, media.mimetype, hints),
    storeMedia(member.family_id, 'audio', msg.waMessageId, media),
  ]);
  await updateIncoming(msg.waMessageId, { text: text || undefined, media_path: path });
  if (!text) {
    return reply(msg.remoteJid, 'Não consegui entender o áudio. 🎙️ Pode repetir ou mandar por texto?', member, msg.waMessageId);
  }
  return handleText(msg, member, text, 'audio');
}

async function handleImage(msg: IncomingMessage, member: Member) {
  const media = await loadMedia(msg, 'image/jpeg');
  const path = await storeMedia(member.family_id, 'imagem', msg.waMessageId, media);
  await updateIncoming(msg.waMessageId, { media_path: path });

  if (!features.agent) {
    return reply(msg.remoteJid, `📸 Foto guardada! ${AGENT_OFF}`, member, msg.waMessageId);
  }
  if (!isClaudeImage(media.mimetype)) {
    return reply(msg.remoteJid, 'Não consigo ler esse formato de imagem. Pode mandar como foto normal (JPG)?', member, msg.waMessageId);
  }
  if (media.buffer.length > 5 * 1024 * 1024) {
    return reply(msg.remoteJid, 'A foto ficou grande demais para eu ler. Pode mandar de novo com qualidade normal?', member, msg.waMessageId);
  }
  const answer = await runAgent(member, {
    text: msg.text,
    image: { base64: media.base64, mimetype: media.mimetype },
    source: 'imagem',
    receiptPath: path,
    messageTime: msg.timestamp,
    currentWaId: msg.waMessageId,
  });
  return reply(msg.remoteJid, answer, member, msg.waMessageId);
}

/** Texto (digitado ou transcrito): comandos fixos primeiro, depois o agente. */
async function handleText(msg: IncomingMessage, member: Member, text: string, source: 'texto' | 'audio') {
  const cmd = parseCommand(text);
  const isAdmin = member.role === 'admin';
  const heard = source === 'audio' ? `🎙️ _"${text}"_\n\n` : '';

  switch (cmd.kind) {
    case 'greeting':
      return reply(msg.remoteJid, `Oi, ${member.name}! 👋 Estou funcionando. Mande *ajuda* para ver o que já sei fazer.`, member);

    case 'help':
      return reply(msg.remoteJid, HELP_TEXT, member);

    case 'list_members': {
      const members = await listMembers(member.family_id);
      const lines = members.map(
        (m) => `• ${m.name}${m.role === 'admin' ? ' (admin)' : ''} — ${formatPhone(m.phone)}`,
      );
      return reply(msg.remoteJid, `*Membros da família* (${members.length})\n${lines.join('\n')}`, member);
    }

    case 'add_member': {
      if (!isAdmin) return reply(msg.remoteJid, 'Só o administrador pode adicionar pessoas.', member);
      const res = await addMember(member.family_id, cmd.name, cmd.phone, cmd.admin ? 'admin' : 'membro');
      if (!res.ok) return reply(msg.remoteJid, `⚠️ ${res.reason}`, member);
      await reply(
        msg.remoteJid,
        `✅ ${res.member.name} ${res.reactivated ? 'voltou para' : 'entrou na'} família${cmd.admin ? ' como admin' : ''} (${formatPhone(res.member.phone)}).`,
        member,
      );
      // Boas-vindas para quem entrou (falha aqui não desfaz o cadastro)
      try {
        await reply(
          res.member.phone,
          `Olá, ${res.member.name}! ${member.name} te adicionou ao assistente da família. 🏠\nMande *ajuda* para ver o que eu faço.`,
          res.member,
        );
      } catch (err) {
        console.error('Não consegui enviar boas-vindas', err);
        await reply(msg.remoteJid, 'Cadastrei, mas não consegui mandar a mensagem de boas-vindas. Confira se o número tem WhatsApp.', member);
      }
      return;
    }

    case 'remove_member': {
      if (!isAdmin) return reply(msg.remoteJid, 'Só o administrador pode remover pessoas.', member);
      const members = await listMembers(member.family_id);
      const asPhone = normalizeBrPhone(cmd.target);
      const byPhone = asPhone ? members.filter((m) => phoneVariants(asPhone).includes(m.phone)) : [];
      const byName = members.filter((m) => m.name.toLowerCase() === cmd.target.trim().toLowerCase());
      const matches = byPhone.length ? byPhone : byName;

      if (matches.length === 0) return reply(msg.remoteJid, `Não encontrei "${cmd.target}" entre os membros. Mande *membros* para ver a lista.`, member);
      if (matches.length > 1) return reply(msg.remoteJid, `Tem mais de uma pessoa com esse nome. Remova pelo número.`, member);
      const target = matches[0]!;
      if (target.id === member.id) return reply(msg.remoteJid, 'Você não pode remover a si mesmo.', member);
      if (target.role === 'admin' && members.filter((m) => m.role === 'admin').length === 1) {
        return reply(msg.remoteJid, 'Não posso remover o único admin da família.', member);
      }
      await deactivateMember(member.family_id, target);
      return reply(msg.remoteJid, `🗑️ ${target.name} foi removido(a). O histórico de gastos dele(a) fica guardado.`, member);
    }

    case 'invalid':
      return reply(msg.remoteJid, cmd.reason, member);

    case 'unknown': {
      if (!features.agent) return reply(msg.remoteJid, `${heard}${AGENT_OFF}`, member);
      const answer = await runAgent(member, {
        text,
        source,
        receiptPath: null,
        messageTime: msg.timestamp,
        currentWaId: msg.waMessageId,
      });
      return reply(msg.remoteJid, `${heard}${answer}`, member);
    }
  }
}
