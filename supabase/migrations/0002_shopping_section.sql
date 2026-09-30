-- Fase 3: lista de compras agrupada por seção dentro de cada local
-- (ex.: supermercado → mercearia, limpeza, hortifruti). Coluna opcional.
alter table shopping_items add column if not exists section text;
