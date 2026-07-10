-- ============================================================================
-- SUIVI DES COMPÉTENCES STI2D — Schéma Supabase
-- À copier/coller intégralement dans : Supabase > SQL Editor > New query > Run
-- Projet : "Progression commune et suivie de compétences"
--
-- Modélisation fidèle au state localStorage "sti2d-tracker-html-v13" :
--   students, competencies, sequences, itProjects, ganttItems,
--   progressions, manual, prefill, teacherPresence + config (jsonb)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0) Fonction utilitaire : mise à jour automatique de updated_at
-- ----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- 1) SETTINGS — configuration en clé/valeur (jsonb)
--    Stocke : meta, calendarConfig, masteryScale, ganttRows,
--    firstOnlyCompetencies, schedule, studentProfiles
--    (structures peu relationnelles -> jsonb, exactement comme dans le state)
-- ----------------------------------------------------------------------------
create table if not exists public.settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);
create trigger trg_settings_updated before update on public.settings
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 2) COMPETENCIES — référentiel STI2D (state.competencies)
--    Le code (ex: "CO1.1") est la clé naturelle utilisée partout dans l'appli
-- ----------------------------------------------------------------------------
create table if not exists public.competencies (
  code        text primary key,               -- "CO1.1"
  label       text not null,                  -- intitulé complet
  updated_at  timestamptz not null default now()
);
create trigger trg_competencies_updated before update on public.competencies
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 3) STUDENTS — élèves (state.students)
--    L'appli identifie les élèves par leur nom -> name en clé primaire.
--    ON UPDATE CASCADE permet de renommer un élève sans casser les liens.
-- ----------------------------------------------------------------------------
create table if not exists public.students (
  name        text primary key,               -- "ADY Théo"
  level       text not null,                  -- "1STI2D" | "TSTI2D"
  group_name  text,                           -- "1STI2D P2" ("group" est réservé en SQL)
  updated_at  timestamptz not null default now()
);
create index if not exists idx_students_level on public.students(level);
create index if not exists idx_students_group on public.students(group_name);
create trigger trg_students_updated before update on public.students
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 4) GANTT_ITEMS — planning (state.ganttItems)
--    id = identifiant commun avec sequences/it_projects (ex "1STI2D-S1", "IT-P1")
-- ----------------------------------------------------------------------------
create table if not exists public.gantt_items (
  id          text primary key,               -- "1STI2D-S1", "IT-P1"...
  row_name    text not null,                  -- "1STI2D IT" | "1STI2D I2D" | "TSTI2D"
  label       text,                           -- libellé court ("Tampon")
  title       text,                           -- problématique / titre long
  start_week  integer not null default 1,
  duration    integer not null default 1,
  kind        text not null default 'sequence'
              check (kind in ('sequence','project')),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_gantt_row on public.gantt_items(row_name);
create trigger trg_gantt_updated before update on public.gantt_items
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 5) SEQUENCES — séquences d'enseignement (state.sequences)
--    competencies : tableau de codes (même forme que dans le state).
-- ----------------------------------------------------------------------------
create table if not exists public.sequences (
  id            text primary key,             -- "1STI2D-S1" (= gantt_items.id)
  title         text not null,
  ref           text,                         -- "Thème 1"
  level         text,                         -- "1STI2D" | "TSTI2D"
  track         text,                         -- "I2D" | "IT" | ...
  competencies  text[] not null default '{}', -- ["CO1.1","CO1.3",...]
  updated_at    timestamptz not null default now()
);
create index if not exists idx_sequences_level on public.sequences(level);
create trigger trg_sequences_updated before update on public.sequences
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 6) IT_PROJECTS — projets informatiques (state.itProjects)
-- ----------------------------------------------------------------------------
create table if not exists public.it_projects (
  id            text primary key,             -- "IT-P1" (= gantt_items.id)
  title         text not null,
  problem       text,                         -- problématique
  mei           text,                         -- "M" | "MEI" ...
  level         text,
  track         text,
  competencies  text[] not null default '{}',
  updated_at    timestamptz not null default now()
);
create trigger trg_itprojects_updated before update on public.it_projects
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 7) PROGRESSIONS — cœur du suivi (state.progressions, ~6700 lignes)
--    1 ligne = statut d'un élève sur une compétence pour une séquence/projet
-- ----------------------------------------------------------------------------
create table if not exists public.progressions (
  student_name     text not null references public.students(name)
                     on delete cascade on update cascade,
  competency_code  text not null references public.competencies(code)
                     on delete cascade on update cascade,
  item_id          text not null references public.gantt_items(id)
                     on delete cascade on update cascade,
  status           text not null default 'N'
                     check (status in ('N','R','O','Y','G')),
  updated_at       timestamptz not null default now(),
  primary key (student_name, competency_code, item_id)
);
create index if not exists idx_prog_item on public.progressions(item_id);
create index if not exists idx_prog_comp on public.progressions(competency_code);
create trigger trg_progressions_updated before update on public.progressions
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 8) MANUAL_EVALUATIONS — évaluations manuelles globales (state.manual)
--    Priment sur la valeur calculée (cf. effectiveValue dans l'appli)
-- ----------------------------------------------------------------------------
create table if not exists public.manual_evaluations (
  student_name     text not null references public.students(name)
                     on delete cascade on update cascade,
  competency_code  text not null references public.competencies(code)
                     on delete cascade on update cascade,
  status           text not null check (status in ('N','R','O','Y','G')),
  score            numeric,                   -- optionnel
  updated_at       timestamptz not null default now(),
  primary key (student_name, competency_code)
);
create trigger trg_manual_updated before update on public.manual_evaluations
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 9) PREFILL — données de pré-remplissage (state.prefill)
-- ----------------------------------------------------------------------------
create table if not exists public.prefill (
  student_name     text not null references public.students(name)
                     on delete cascade on update cascade,
  competency_code  text not null references public.competencies(code)
                     on delete cascade on update cascade,
  group_name       text,
  level            text,
  score            numeric,
  status           text check (status in ('N','R','O','Y','G')),
  primary key (student_name, competency_code)
);

-- ----------------------------------------------------------------------------
-- 10) TEACHER_PRESENCE — profs présents par séquence (state.teacherPresence)
--     Dans le state : { "1STI2D-S1": ["SMITH","HURAUX"], ... }
-- ----------------------------------------------------------------------------
create table if not exists public.teacher_presence (
  item_id   text not null references public.gantt_items(id)
              on delete cascade on update cascade,
  teacher   text not null,                    -- "SMITH", "HURAUX"...
  primary key (item_id, teacher)
);

-- ============================================================================
-- SÉCURITÉ (RLS) — compte partagé unique pour les 5 profs :
-- tout utilisateur AUTHENTIFIÉ a tous les droits, les anonymes n'ont rien.
-- ============================================================================
do $$
declare t text;
begin
  foreach t in array array['settings','competencies','students','gantt_items',
    'sequences','it_projects','progressions','manual_evaluations','prefill',
    'teacher_presence']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "profs_full_access" on public.%I', t);
    execute format(
      'create policy "profs_full_access" on public.%I
         for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- ============================================================================
-- TEMPS RÉEL — publie les changements pour la synchro live entre profs
-- (si une table est déjà dans la publication, l'erreur est ignorée)
-- ============================================================================
do $$
declare t text;
begin
  foreach t in array array['settings','competencies','students','gantt_items',
    'sequences','it_projects','progressions','manual_evaluations','prefill',
    'teacher_presence']
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- ============================================================================
-- FIN — Vérification rapide : la requête suivante doit lister 10 tables
-- ============================================================================
select table_name from information_schema.tables
where table_schema = 'public' order by table_name;
