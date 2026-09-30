import { db, type Member } from '../db/supabase.js';
import { phoneVariants } from '../whatsapp/phone.js';

export async function findActiveMemberByPhone(phone: string): Promise<Member | null> {
  const { data, error } = await db
    .from('members')
    .select('id, family_id, name, phone, role, active')
    .in('phone', phoneVariants(phone))
    .eq('active', true)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as Member) ?? null;
}

export async function listMembers(familyId: string): Promise<Member[]> {
  const { data, error } = await db
    .from('members')
    .select('id, family_id, name, phone, role, active')
    .eq('family_id', familyId)
    .eq('active', true)
    .order('created_at');
  if (error) throw error;
  return (data ?? []) as Member[];
}

export type AddResult =
  | { ok: true; member: Member; reactivated: boolean }
  | { ok: false; reason: string };

export async function addMember(
  familyId: string,
  name: string,
  phone: string,
  role: 'admin' | 'membro',
): Promise<AddResult> {
  const { data: existing, error: findErr } = await db
    .from('members')
    .select('id, family_id, name, phone, role, active')
    .in('phone', phoneVariants(phone))
    .maybeSingle();
  if (findErr) throw findErr;

  if (existing) {
    if (existing.family_id !== familyId) {
      return { ok: false, reason: 'Esse número já está cadastrado em outra família.' };
    }
    if (existing.active) return { ok: false, reason: `Esse número já é de ${existing.name}.` };
    const { data, error } = await db
      .from('members')
      .update({ active: true, name, role })
      .eq('id', existing.id)
      .select('id, family_id, name, phone, role, active')
      .single();
    if (error) throw error;
    return { ok: true, member: data as Member, reactivated: true };
  }

  const { data, error } = await db
    .from('members')
    .insert({ family_id: familyId, name, phone, role })
    .select('id, family_id, name, phone, role, active')
    .single();
  if (error) throw error;
  return { ok: true, member: data as Member, reactivated: false };
}

/** Desativa (não apaga) para manter o histórico de gastos de quem saiu. */
export async function deactivateMember(familyId: string, target: Member) {
  const { error } = await db
    .from('members')
    .update({ active: false })
    .eq('id', target.id)
    .eq('family_id', familyId);
  if (error) throw error;
}
