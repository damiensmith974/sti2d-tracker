-- ============================================================================
-- SUIVI DES COMPÉTENCES STI2D — Création des 4 comptes profs
-- ============================================================================
-- MÉTHODE RECOMMANDÉE : l'interface Supabase (plus fiable que le SQL)
--   Supabase > Authentication > Users > "Add user" > "Create new user"
--   Pour chaque prof : email + mot de passe, et COCHER "Auto Confirm User".
--
-- MÉTHODE ALTERNATIVE : ce script SQL (Supabase > SQL Editor > Run).
--   1. CHANGER les 4 mots de passe ci-dessous AVANT d'exécuter.
--   2. Le script ignore les comptes déjà existants (relançable sans risque).
-- ============================================================================

create extension if not exists pgcrypto;

do $$
declare
  u record;
  uid uuid;
begin
  for u in
    select * from (values
      -- ( email                                , mot de passe initial )
      ('damien.smith@ac-reunion.fr'             , 'Smith!Sti2d2026'),
      ('pierre-yves.huraux@ac-reunion.fr'       , 'Huraux!Sti2d2026'),
      ('davy.thiaw-woaye@ac-reunion.fr'         , 'Thiaw!Sti2d2026'),
      ('christopher.nativel@ac-reunion.fr'      , 'Nativel!Sti2d2026')
    ) as t(email, pwd)
  loop
    -- ne rien faire si le compte existe déjà
    if exists (select 1 from auth.users where lower(email) = lower(u.email)) then
      raise notice 'Compte déjà existant, ignoré : %', u.email;
      continue;
    end if;

    uid := gen_random_uuid();

    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) values (
      '00000000-0000-0000-0000-000000000000', uid,
      'authenticated', 'authenticated',
      lower(u.email),
      crypt(u.pwd, gen_salt('bf')),          -- mot de passe hashé (bcrypt)
      now(),                                  -- email confirmé d'office
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{}'::jsonb,
      now(), now(),
      '', '', '', ''                          -- évite un bug GoTrue avec NULL
    );

    insert into auth.identities (
      id, user_id, provider_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(), uid, uid::text,
      jsonb_build_object('sub', uid::text, 'email', lower(u.email), 'email_verified', true),
      'email', now(), now(), now()
    );

    raise notice 'Compte créé : %', u.email;
  end loop;
end $$;

-- Vérification : doit lister les 4 profs
select email, email_confirmed_at, created_at
from auth.users
where email like '%ac-reunion.fr'
order by email;
