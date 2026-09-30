import { db, type Member } from '../db/supabase.js';
import type { ToolDefinition } from './claude.js';
import { localIso, parseLocalDateTime } from './format.js';
import { cancelPendingReminders, EVENT_COLS, scheduleEventReminders, type EventRow } from './reminders.js';
import { addDays, eventCreatedText, eventListText, localYmd, spAt, type EventView } from './schedule-format.js';
import { normText } from './shopping-format.js';
import type { AgentContext } from './tools.js';

type ToolResult = { ok: boolean; resultado: string };

const REMIND_DESC =
  'Minutos antes para avisar. Padrão [1440, 60] (1 dia e 1 hora antes). Ex.: "me lembra 30 min antes" = [30].';

export const agendaToolDefinitions: ToolDefinition[] = [
  {
    name: 'criar_compromisso',
    description:
      'Agenda um compromisso com aviso antes ("dentista quinta às 14h", "reunião da escola dia 10 às 19h30"). ' +
      'Se faltar o horário, pergunte antes (use responder).',
    input_schema: {
      type: 'object',
      properties: {
        titulo: { type: 'string', description: 'Curto e claro: "Dentista da Ana", "Reunião da escola".' },
        inicio: { type: 'string', description: 'Data e hora no horário de São Paulo: "AAAA-MM-DDTHH:MM".' },
        local: { type: 'string' },
        participantes: { type: 'array', items: { type: 'string' }, description: 'Nomes dos membros da família que devem ser avisados. Omita = só quem pediu.' },
        lembrar_antes_min: { type: 'array', items: { type: 'number' }, description: REMIND_DESC },
      },
      required: ['titulo', 'inicio'],
    },
  },
  {
    name: 'listar_compromissos',
    description: 'Mostra a agenda da família ("o que temos amanhã?", "agenda da semana"). Sem datas = próximos 7 dias.',
    input_schema: {
      type: 'object',
      properties: {
        de: { type: 'string', description: 'Data inicial "AAAA-MM-DD".' },
        ate: { type: 'string', description: 'Data final "AAAA-MM-DD" (inclusive).' },
      },
    },
  },
  {
    name: 'editar_compromisso',
    description: 'Muda um compromisso ("o dentista passou para as 15h", "muda o local para..."). Envie só o que muda.',
    input_schema: {
      type: 'object',
      properties: {
        compromisso_id: { type: 'string', description: 'id (veja "Próximos compromissos"). Omita = o último criado por esta pessoa.' },
        titulo: { type: 'string' },
        inicio: { type: 'string', description: '"AAAA-MM-DDTHH:MM" em São Paulo.' },
        local: { type: 'string' },
        participantes: { type: 'array', items: { type: 'string' } },
        lembrar_antes_min: { type: 'array', items: { type: 'number' }, description: REMIND_DESC },
      },
    },
  },
  {
    name: 'cancelar_compromisso',
    description: 'Cancela um compromisso. Pergunte antes e só chame com confirmado_pelo_usuario=true depois do "sim".',
    input_schema: {
      type: 'object',
      properties: { compromisso_id: { type: 'string' }, confirmado_pelo_usuario: { type: 'boolean' } },
      required: ['confirmado_pelo_usuario'],
    },
  },
];

export const AGENDA_TOOLS = new Set(agendaToolDefinitions.map((t) => t.name));

async function familyMembers(familyId: string): Promise<Member[]> {
  const { data, error } = await db.from('members').select('id, family_id, name, phone, role, active').eq('family_id', familyId).eq('active', true);
  if (error) throw error;
  return (data ?? []) as Member[];
}

/** Nomes ditos → ids de membros. Quem pediu entra sempre. Devolve também os nomes não encontrados. */
function resolveParticipants(names: unknown, members: Member[], me: Member): { ids: string[]; unknown: string[] } {
  const ids = new Set<string>([me.id]);
  const unknown: string[] = [];
  if (Array.isArray(names)) {
    for (const raw of names) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const n = normText(raw);
      if (/^(eu|mim|todos|todo mundo|familia|a familia)$/.test(n)) {
        if (n !== 'eu' && n !== 'mim') members.forEach((m) => ids.add(m.id));
        continue;
      }
      const m = members.find((x) => normText(x.name) === n) ?? members.find((x) => normText(x.name).split(' ')[0] === n.split(' ')[0]);
      if (m) ids.add(m.id);
      else unknown.push(raw.trim());
    }
  }
  return { ids: [...ids], unknown };
}

function validReminders(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const mins = v.map(Number).filter((n) => Number.isFinite(n) && n >= 0 && n <= 60 * 24 * 30).map(Math.round);
  return mins.length ? mins : null;
}

function view(ev: EventRow, members: Member[]): EventView {
  const names = (ev.participants ?? []).map((id) => members.find((m) => m.id === id)?.name).filter((x): x is string => Boolean(x));
  return { title: ev.title, starts_at: new Date(ev.starts_at), location: ev.location, participants: names, remind_before: ev.remind_before ?? [1440, 60] };
}

async function findEvent(ctx: AgentContext, id: unknown): Promise<EventRow | null> {
  let q = db.from('events').select(EVENT_COLS).eq('family_id', ctx.member.family_id);
  if (typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)) q = q.eq('id', id);
  else q = q.eq('created_by', ctx.member.id).gte('starts_at', new Date().toISOString());
  const { data, error } = await q.order('starts_at', { ascending: true }).limit(1).maybeSingle();
  if (error) throw error;
  return (data as EventRow) ?? null;
}

/** "AAAA-MM-DDTHH:MM" obrigatório: sem hora não dá para avisar na hora certa. */
function parseStart(v: unknown, now: Date): Date | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v.trim())) return null;
  // parseLocalDateTime recusa datas futuras (feito para gastos); aqui o "agora" de referência vai para longe
  const d = parseLocalDateTime(v, new Date(NaN), new Date(now.getTime() + 5 * 365 * 24 * 3600 * 1000));
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function upcomingEventsContext(familyId: string, now = new Date()): Promise<string[]> {
  const { data } = await db
    .from('events')
    .select('id, title, starts_at')
    .eq('family_id', familyId)
    .gte('starts_at', now.toISOString())
    .order('starts_at', { ascending: true })
    .limit(10);
  return (data ?? []).map((e: { id: string; title: string; starts_at: string }) => `- id ${e.id} | ${e.title} | ${localIso(new Date(e.starts_at)).replace('T', ' ')}`);
}

export async function executeAgendaTool(name: string, input: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const now = new Date();
  const members = await familyMembers(ctx.member.family_id);

  switch (name) {
    case 'criar_compromisso': {
      const title = typeof input.titulo === 'string' ? input.titulo.trim() : '';
      const start = parseStart(input.inicio, now);
      if (!title) return { ok: false, resultado: 'Falta o título. Pergunte o que é o compromisso.' };
      if (!start) return { ok: false, resultado: 'Falta data e hora completas ("AAAA-MM-DDTHH:MM"). Pergunte o horário.' };
      if (start < new Date(now.getTime() - 60 * 60_000)) return { ok: false, resultado: 'Essa data já passou. Confirme a data com a pessoa.' };
      const { ids, unknown } = resolveParticipants(input.participantes, members, ctx.member);
      const { data, error } = await db
        .from('events')
        .insert({
          family_id: ctx.member.family_id,
          created_by: ctx.member.id,
          title,
          starts_at: start.toISOString(),
          location: typeof input.local === 'string' && input.local.trim() ? input.local.trim() : null,
          participants: ids,
          remind_before: validReminders(input.lembrar_antes_min) ?? [1440, 60],
        })
        .select(EVENT_COLS)
        .single();
      if (error) throw error;
      const ev = data as EventRow;
      await scheduleEventReminders(ev, now);
      ctx.replies.push(eventCreatedText(view(ev, members), now) + (unknown.length ? `\n❓ Não achei na família: ${unknown.join(', ')}` : ''));
      return { ok: true, resultado: `Compromisso ${ev.id} criado. A confirmação já foi enviada.` };
    }

    case 'listar_compromissos': {
      const today = localYmd(now);
      const de = typeof input.de === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.de) ? input.de : today;
      const ate = typeof input.ate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.ate) ? input.ate : addDays(de, 6);
      const from = de === today ? now : spAt(de, '00:00');
      const { data, error } = await db
        .from('events')
        .select(EVENT_COLS)
        .eq('family_id', ctx.member.family_id)
        .gte('starts_at', from.toISOString())
        .lt('starts_at', spAt(addDays(ate, 1), '00:00').toISOString())
        .order('starts_at', { ascending: true });
      if (error) throw error;
      const title = de === ate ? (de === today ? 'Agenda de hoje' : de === addDays(today, 1) ? 'Agenda de amanhã' : `Agenda de ${de.slice(8, 10)}/${de.slice(5, 7)}`) : `Agenda até ${ate.slice(8, 10)}/${ate.slice(5, 7)}`;
      ctx.replies.push(eventListText(((data ?? []) as EventRow[]).map((e) => view(e, members)), now, title));
      return { ok: true, resultado: 'Agenda enviada. A confirmação já foi enviada.' };
    }

    case 'editar_compromisso': {
      const ev = await findEvent(ctx, input.compromisso_id);
      if (!ev) return { ok: false, resultado: 'Não encontrei o compromisso. Pergunte qual é.' };
      const patch: Partial<EventRow> = {};
      if (typeof input.titulo === 'string' && input.titulo.trim()) patch.title = input.titulo.trim();
      if (input.inicio !== undefined) {
        const start = parseStart(input.inicio, now);
        if (!start) return { ok: false, resultado: 'Horário inválido: use "AAAA-MM-DDTHH:MM".' };
        patch.starts_at = start.toISOString();
      }
      if (typeof input.local === 'string') patch.location = input.local.trim() || null;
      if (input.participantes !== undefined) patch.participants = resolveParticipants(input.participantes, members, ctx.member).ids;
      const rem = validReminders(input.lembrar_antes_min);
      if (rem) patch.remind_before = rem;
      if (!Object.keys(patch).length) return { ok: false, resultado: 'Nada para mudar. Pergunte o que deve mudar.' };
      const { data, error } = await db.from('events').update(patch).eq('id', ev.id).select(EVENT_COLS).single();
      if (error) throw error;
      const updated = data as EventRow;
      await scheduleEventReminders(updated, now);
      ctx.replies.push(eventCreatedText(view(updated, members), now).replace('Compromisso agendado', 'Compromisso atualizado'));
      return { ok: true, resultado: 'Compromisso atualizado. A confirmação já foi enviada.' };
    }

    case 'cancelar_compromisso': {
      const ev = await findEvent(ctx, input.compromisso_id);
      if (!ev) return { ok: false, resultado: 'Não encontrei o compromisso.' };
      if (input.confirmado_pelo_usuario !== true) {
        return { ok: false, resultado: `Ainda não confirmado. Pergunte: "Cancelo ${ev.title}?"` };
      }
      await cancelPendingReminders([ev.id], ['evento']);
      const { error } = await db.from('events').delete().eq('id', ev.id).eq('family_id', ctx.member.family_id);
      if (error) throw error;
      ctx.replies.push(`🗑️ Compromisso cancelado: ${ev.title}`);
      return { ok: true, resultado: 'Cancelado. A confirmação já foi enviada.' };
    }

    default:
      return { ok: false, resultado: `Ferramenta desconhecida: ${name}` };
  }
}
