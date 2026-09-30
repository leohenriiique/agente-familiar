-- Fase 4: contas anuais (dia + mês) e únicas (data exata), e quem cadastrou
alter table bills add column if not exists due_month int check (due_month between 1 and 12);
alter table bills add column if not exists due_date date;
alter table bills add column if not exists created_by uuid references members on delete set null;
alter table bills add column if not exists created_at timestamptz default now();
