/**
 * Cria a família, o primeiro admin e as categorias padrão.
 *
 *   npm run setup:familia -- "Família Silva" "Leo" "34 99999-9999"
 */
import { db } from '../src/db/supabase.js';
import { normalizeBrPhone } from '../src/whatsapp/phone.js';

const [familyName, adminName, rawPhone] = process.argv.slice(2);
if (!familyName || !adminName || !rawPhone) {
  console.error('Uso: npm run setup:familia -- "<nome da família>" "<seu nome>" "<seu telefone com DDD>"');
  process.exit(1);
}

const phone = normalizeBrPhone(rawPhone);
if (!phone) {
  console.error(`Telefone inválido: ${rawPhone}`);
  process.exit(1);
}

const { data: exists } = await db.from('members').select('id').eq('phone', phone).maybeSingle();
if (exists) {
  console.error(`O número ${phone} já está cadastrado. Nada foi criado.`);
  process.exit(1);
}

const { data: family, error: famErr } = await db
  .from('families')
  .insert({ name: familyName })
  .select('id, name')
  .single();
if (famErr) throw famErr;

const { error: memErr } = await db
  .from('members')
  .insert({ family_id: family.id, name: adminName, phone, role: 'admin' });
if (memErr) {
  await db.from('families').delete().eq('id', family.id);
  throw memErr;
}

const { error: catErr } = await db.rpc('seed_default_categories', { p_family: family.id });
if (catErr) throw catErr;

console.log(`✅ Família "${family.name}" criada (id ${family.id}).`);
console.log(`✅ Admin: ${adminName} — ${phone}`);
console.log('✅ Categorias padrão criadas.');
console.log('Agora mande "oi" para o número do agente no WhatsApp.');
