-- ─────────────────────────────────────────────────────────────────────────────
-- MD Lanciano — algoritmo turni + multi-store login
-- Da eseguire nel SQL Editor di Supabase (progetto fgdxjnnposxfziwjehqt / m6dsign)
-- Usa i nomi di tabella REALI del progetto: stores, employees, shifts, managers
-- (NON turni_stores/turni_employees/turni_managers — quelle non esistono e
--  l'app non le legge mai)
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Store MD Lanciano — crealo solo se non esiste già
INSERT INTO stores (nome)
SELECT 'MD Lanciano'
WHERE NOT EXISTS (SELECT 1 FROM stores WHERE nome = 'MD Lanciano');

-- 2. Rimuovi il vincolo ore_settimanali IN (20,30,40) e riaggiungilo con i nuovi valori.
-- NOTA: se il nome del constraint generato da Postgres è diverso da quello sotto,
-- trovalo con questa query prima di eseguire il DROP:
--   SELECT conname FROM pg_constraint WHERE conrelid = 'employees'::regclass AND contype = 'c';
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_ore_settimanali_check;
ALTER TABLE employees ADD CONSTRAINT employees_ore_settimanali_check
  CHECK (ore_settimanali IN (20, 22, 28, 30, 35, 36, 40, 46));

-- 3. Nuove colonne su employees (additive — non tocca Stroili, restano ai default)
ALTER TABLE employees ADD COLUMN IF NOT EXISTS ruolo TEXT DEFAULT 'cassiere';
-- ruolo: 'cassiere' | 'non_cassiere'
ALTER TABLE employees ADD COLUMN IF NOT EXISTS priorita_cassa INT DEFAULT 1;
-- 1=22h, 2=28h, 3=30h, 4=35h/46h
ALTER TABLE employees ADD COLUMN IF NOT EXISTS turno_fisso TEXT DEFAULT NULL;
-- 'mattina' | 'pomeriggio' | NULL (libero)
ALTER TABLE employees ADD COLUMN IF NOT EXISTS alternanza_gruppo TEXT DEFAULT NULL;
-- 'AB' per Max/Carlo che si alternano mattina/pomeriggio a settimane alterne

-- 4. Vincolo tipo su shifts: aggiungi domenica_lungo/domenica_corto (additivo)
-- Stessa nota di cui sopra se il nome del constraint differisce:
--   SELECT conname FROM pg_constraint WHERE conrelid = 'shifts'::regclass AND contype = 'c';
ALTER TABLE shifts DROP CONSTRAINT IF EXISTS shifts_tipo_check;
ALTER TABLE shifts ADD CONSTRAINT shifts_tipo_check
  CHECK (tipo IN ('mattina', 'pomeriggio', 'full', 'riposo', 'domenica_lungo', 'domenica_corto'));

-- 4bis. CLEANUP — rimuove la riga "Gilda" placeholder creata a mano dalla UI
-- (20h, ruolo default, nessun turno_fisso) PRIMA che questo script esistesse.
-- Questa riga aveva bloccato l'inserimento dei 12 dipendenti reali al primo run
-- (il guard "IF NOT EXISTS" allo step 5 vedeva già 1 riga e saltava tutto).
-- Cascade: elimina anche i 31 turni + 1 permesso di test già generati per quella riga.
DO $$
DECLARE
  md_store_id UUID;
BEGIN
  SELECT id INTO md_store_id FROM stores WHERE nome = 'MD Lanciano' LIMIT 1;

  DELETE FROM employees
  WHERE store_id = md_store_id
    AND nome = 'Gilda'
    AND ore_settimanali = 20
    AND turno_fisso IS NULL;
END $$;

-- 5. Dipendenti MD Lanciano — ESEGUI UNA SOLA VOLTA.
-- Non esiste un vincolo UNIQUE su (store_id, nome): un secondo run duplicherebbe i 12 dipendenti.
DO $$
DECLARE
  md_store_id UUID;
BEGIN
  SELECT id INTO md_store_id FROM stores WHERE nome = 'MD Lanciano' LIMIT 1;

  IF NOT EXISTS (SELECT 1 FROM employees WHERE store_id = md_store_id) THEN

    INSERT INTO employees (store_id, nome, ore_settimanali, ruolo, priorita_cassa, turno_fisso, alternanza_gruppo) VALUES
      (md_store_id, 'Yuri',     46, 'cassiere',     4, NULL,       NULL),
      (md_store_id, 'Gilda',    36, 'non_cassiere', 0, 'mattina',  NULL),
      (md_store_id, 'Tony',     36, 'non_cassiere', 0, 'mattina',  NULL),
      (md_store_id, 'Max',      35, 'cassiere',     4, NULL,       'AB'),
      (md_store_id, 'Carlo',    35, 'cassiere',     4, NULL,       'AB'),
      (md_store_id, 'Cristina', 30, 'cassiere',     3, NULL,       NULL),
      (md_store_id, 'Romeo',    28, 'cassiere',     2, NULL,       NULL),
      (md_store_id, 'Stefania', 28, 'cassiere',     2, NULL,       NULL),
      (md_store_id, 'Marilena', 22, 'cassiere',     1, NULL,       NULL),
      (md_store_id, 'Angelica', 22, 'cassiere',     1, NULL,       NULL),
      (md_store_id, 'Elisa',    22, 'cassiere',     1, NULL,       NULL),
      (md_store_id, 'Damiana',  22, 'cassiere',     1, NULL,       NULL);

  END IF;
END $$;

-- 6. Tabella managers — usa quella ESISTENTE (già usata da /api/auth/login con bcrypt).
-- Se per qualche motivo non esiste ancora, questa CREATE la crea con la struttura corretta.
CREATE TABLE IF NOT EXISTS managers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Password 'turni2025' già hashata con bcryptjs (10 rounds) — MAI testo in chiaro.
INSERT INTO managers (store_id, email, password_hash)
SELECT id, 'giac@md-lanciano.it', '$2b$10$7gurucFLeOxgsIG.HdsMfe9H1x7uGG9G/XG4o1Q9NKZPC6VR1g0V6'
FROM stores WHERE nome = 'MD Lanciano'
ON CONFLICT (email) DO NOTHING;
