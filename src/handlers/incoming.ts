import { config } from '../config.js';
import { db, type Member } from '../db/supabase.js';
import { sendText, sendTyping } from '../whatsapp/evolution.js';
import type { IncomingMessage } from '../whatsapp/parse.js';
import { normalizeBrPhone, phoneVariants } from '../whatsapp/phone.js';
import { HELP_TEXT, parseCommand } from './commands.js';
import { logIncoming, logOutgoing } from './log.js';
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

  await sendTyping(msg.remoteJid, 1500);

  if (msg.type !== 'text') {
    const what = { audio: 'áudio', image: 'foto', document: 'documento', other: 'esse tipo de mensagem' }[msg.type];
    await reply(
      msg.remoteJid,
      `Recebi seu ${what}, ${member.name}! 👍 Ler ${what === 'foto' ? 'fotos de cupons' : what + 's'} chega na próxima fase. Por enquanto, me mande por texto.`,
      member,
      msg.waMessageId,
    );
    return;
  }

  const cmd = parseCommand(msg.text);
  const isAdmin = member.role === 'admin';

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

    case 'unknown':
      return reply(
        msg.remoteJid,
        `Ainda não sei fazer isso, ${member.name}. 🙂 Gastos, compras, agenda e contas chegam nas próximas fases. Mande *ajuda* para ver o que já funciona.`,
        member,
      );
  }
}
