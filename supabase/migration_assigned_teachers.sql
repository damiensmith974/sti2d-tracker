-- ============================================================================
-- MIGRATION — Assignation des profs aux séquences (Feature 2)
-- À copier/coller dans : Supabase > SQL Editor > New query > Run
-- Sans danger : peut être exécutée plusieurs fois (IF NOT EXISTS).
-- ============================================================================

-- 1) Colonne `assigned_teachers` : tableau JSON des profs qui font la séquence
--    Ex : ["SMITH","HURAUX"]  — vide par défaut.
alter table public.sequences
  add column if not exists assigned_teachers jsonb not null default '[]'::jsonb;

comment on column public.sequences.assigned_teachers is
  'Profs assignés à la séquence, ex ["SMITH","HURAUX","THIAW-WOAYE","NATIVEL"]';

-- 2) Rien à faire pour la table `students` : elle existe déjà (name, level,
--    group_name) et couvre l''onglet "Classe". RLS et temps réel sont déjà
--    actifs sur students et sequences (cf. supabase_schema.sql).

-- 3) Vérification rapide : doit afficher la colonne assigned_teachers (jsonb)
select column_name, data_type, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'sequences'
order by ordinal_position;
