import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

export const db = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export type Member = {
  id: string;
  family_id: string;
  name: string;
  phone: string;
  role: 'admin' | 'membro';
  active: boolean;
};
