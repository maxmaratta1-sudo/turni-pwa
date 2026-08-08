-- Turno spezzato manuale — parte 2: il check constraint "shifts_tipo_check" sul campo
-- "tipo" blocca qualsiasi valore non nella lista originale — servono anche
-- "spezzato_mattina" e "spezzato_pomeriggio" (8 agosto 2026). Trova il constraint
-- dinamicamente (stesso pattern robusto del primo script) invece di assumere il nome,
-- anche se dall'errore sappiamo già che si chiama "shifts_tipo_check".

DO $$
DECLARE
  tipo_constraint_name text;
BEGIN
  SELECT con.conname INTO tipo_constraint_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace ns ON ns.oid = rel.relnamespace
  WHERE rel.relname = 'shifts' AND ns.nspname = 'public'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) LIKE '%tipo%';

  IF tipo_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.shifts DROP CONSTRAINT %I', tipo_constraint_name);
    RAISE NOTICE 'Check constraint su tipo rimosso: %', tipo_constraint_name;
  ELSE
    RAISE NOTICE 'Nessun check constraint su tipo trovato — proseguo comunque con la ricreazione.';
  END IF;
END $$;

ALTER TABLE public.shifts ADD CONSTRAINT shifts_tipo_check
  CHECK (tipo IN (
    'mattina', 'pomeriggio', 'full', 'riposo', 'domenica_lungo', 'domenica_corto',
    'yuri_full', 'yuri_pomeriggio', 'mattina_corta', 'pomeriggio_corto',
    'turno_breve_11_14', 'turno_breve_12_15', 'turno_breve_13_16', 'turno_breve_17_20',
    'spezzato_mattina', 'spezzato_pomeriggio'
  ));
