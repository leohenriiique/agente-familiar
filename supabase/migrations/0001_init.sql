-- Agente Familiar — fase 1: modelo completo (as tabelas das próximas fases já ficam prontas)

create extension if not exists pgcrypto;

create table families (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'America/Sao_Paulo',
  created_at timestamptz default now()
);

create table members (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families on delete cascade,
  name text not null,
  phone text unique not null,             -- só dígitos, com DDI: 5534999999999
  role text not null default 'membro' check (role in ('admin','membro')),
  active boolean not null default true,
  created_at timestamptz default now()
);

create table categories (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families on delete cascade,
  name text not null,
  emoji text,
  keywords text[] default '{}',
  unique (family_id, name)
);

create table expenses (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families on delete cascade,
  member_id uuid references members on delete set null,
  category_id uuid references categories on delete set null,
  amount_cents bigint not null check (amount_cents > 0),
  description text,
  merchant text,
  spent_at timestamptz not null default now(),
  payment_method text,
  source text check (source in ('texto','audio','imagem')),
  receipt_path text,
  status text not null default 'confirmado' check (status in ('confirmado','pendente')),
  created_at timestamptz default now()
);
create index on expenses (family_id, spent_at);

create table events (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families on delete cascade,
  created_by uuid references members on delete set null,
  title text not null,
  starts_at timestamptz not null,
  ends_at timestamptz,
  location text,
  remind_before int[] default '{1440,60}',
  participants uuid[] default '{}'
);

create table shopping_items (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families on delete cascade,
  added_by uuid references members on delete set null,
  item text not null,
  quantity text,
  store_type text not null default 'supermercado',
  created_at timestamptz default now(),
  bought_at timestamptz,
  bought_by uuid references members on delete set null
);
create index on shopping_items (family_id, store_type) where bought_at is null;

create table bills (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families on delete cascade,
  name text not null,
  amount_cents bigint,
  due_day int check (due_day between 1 and 31),
  recurrence text not null default 'mensal' check (recurrence in ('mensal','anual','unica')),
  remind_days_before int[] default '{3,0}',
  active boolean default true
);

create table bill_payments (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references bills on delete cascade,
  due_date date not null,
  paid_at timestamptz,
  paid_by uuid references members on delete set null,
  expense_id uuid references expenses on delete set null,
  unique (bill_id, due_date)
);

create table reminders (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families on delete cascade,
  target_member_id uuid references members on delete cascade,
  kind text not null,
  ref_id uuid,
  send_at timestamptz not null,
  sent_at timestamptz,
  payload jsonb,
  unique (kind, ref_id, target_member_id, send_at)
);
create index on reminders (send_at) where sent_at is null;

create table messages (
  id uuid primary key default gen_random_uuid(),
  family_id uuid references families on delete cascade,
  member_id uuid references members on delete set null,
  direction text not null check (direction in ('in','out')),
  type text,
  text text,
  media_path text,
  wa_message_id text unique,
  remote_jid text,
  created_at timestamptz default now()
);
create index on messages (member_id, created_at desc);

-- RLS ligada em tudo: o backend usa a service role (que ignora RLS);
-- nada fica exposto pela chave anon.
alter table families enable row level security;
alter table members enable row level security;
alter table categories enable row level security;
alter table expenses enable row level security;
alter table events enable row level security;
alter table shopping_items enable row level security;
alter table bills enable row level security;
alter table bill_payments enable row level security;
alter table reminders enable row level security;
alter table messages enable row level security;

-- Cria as categorias padrão de uma família
create or replace function seed_default_categories(p_family uuid)
returns void language sql as $$
  insert into categories (family_id, name, emoji) values
    (p_family, 'Mercado', '🛒'),
    (p_family, 'Alimentação fora', '🍔'),
    (p_family, 'Transporte', '🚌'),
    (p_family, 'Combustível', '⛽'),
    (p_family, 'Moradia', '🏠'),
    (p_family, 'Contas da casa', '💡'),
    (p_family, 'Saúde', '💊'),
    (p_family, 'Educação', '📚'),
    (p_family, 'Lazer', '🎉'),
    (p_family, 'Vestuário', '👕'),
    (p_family, 'Pets', '🐾'),
    (p_family, 'Presentes', '🎁'),
    (p_family, 'Outros', '📦')
  on conflict (family_id, name) do nothing;
$$;

-- Bucket privado para comprovantes e áudios (usado a partir da fase 2)
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;
