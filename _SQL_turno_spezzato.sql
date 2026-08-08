-- Turno spezzato manuale (mattina + pomeriggio nello stesso giorno) — 8 agosto 2026
-- Vedi CLAUDE.md per la documentazione completa.
--
-- NOTA: la tabella si chiama "shifts", non "turni_shifts" (nome corretto verificato nel
-- codice — src/app/manager/page.tsx usa sempre supabase.from('shifts')).
--
-- Il nome esatto del constraint UNIQUE esistente su (schedule_id, employee_id, data) non
-- è noto a priori — questo script lo trova dinamicamente interrogando pg_constraint
-- invece di richiedere un nome hardcoded (più sicuro: funziona indipendentemente da come
-- si chiama realmente).

-- 🐛 Primo tentativo fallito con "relation shifts does not exist": molto probabilmente
-- un problema di search_path nella sessione dello SQL Editor (lo schema "public" non
-- risolto implicitamente) — qui sotto tutto è qualificato esplicitamente con "public."
-- per essere indipendente dal search_path della sessione.

DO $$
DECLARE
  old_constraint_name text;
  tbl_oid oid;
BEGIN
  SELECT rel.oid INTO tbl_oid
  FROM pg_class rel
  JOIN pg_namespace ns ON ns.oid = rel.relnamespace
  WHERE rel.relname = 'shifts' AND ns.nspname = 'public';

  IF tbl_oid IS NULL THEN
    RAISE EXCEPTION 'Tabella public.shifts non trovata — verificare il nome esatto/schema nel dashboard Supabase (Table Editor) prima di rieseguire.';
  END IF;

  SELECT con.conname INTO old_constraint_name
  FROM pg_constraint con
  WHERE con.conrelid = tbl_oid
    AND con.contype = 'u'
    AND (
      SELECT array_agg(attname::text ORDER BY attname)
      FROM pg_attribute
      WHERE attrelid = con.conrelid AND attnum = ANY(con.conkey)
    ) = ARRAY['data', 'employee_id', 'schedule_id']::text[];

  IF old_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.shifts DROP CONSTRAINT %I', old_constraint_name);
    RAISE NOTICE 'Constraint rimosso: %', old_constraint_name;
  ELSE
    RAISE NOTICE 'Nessun constraint UNIQUE(schedule_id, employee_id, data) trovato su public.shifts — nulla da rimuovere.';
  END IF;
END $$;

ALTER TABLE public.shifts ADD COLUMN IF NOT EXISTS sequenza INT NOT NULL DEFAULT 1;

ALTER TABLE public.shifts ADD CONSTRAINT shifts_schedule_employee_data_seq_key
  UNIQUE (schedule_id, employee_id, data, sequenza);
