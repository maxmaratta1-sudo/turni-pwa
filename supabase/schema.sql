-- TURNI PWA — Schema v1.0

-- Stores
CREATE TABLE stores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Employees
CREATE TABLE employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  ore_settimanali INT NOT NULL CHECK (ore_settimanali IN (20, 30, 40)),
  token TEXT UNIQUE NOT NULL DEFAULT gen_random_uuid()::TEXT,
  attivo BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Schedules (piano mensile)
CREATE TABLE schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
  mese INT NOT NULL, -- 1-12
  anno INT NOT NULL,
  stato TEXT NOT NULL DEFAULT 'bozza', -- bozza | pubblicato
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(store_id, mese, anno)
);

-- Unavailabilities (richieste dipendenti)
CREATE TABLE unavailabilities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
  schedule_id UUID REFERENCES schedules(id) ON DELETE CASCADE,
  data DATE NOT NULL,
  motivo TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(employee_id, data)
);

-- Shifts (turni generati)
CREATE TABLE shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id UUID REFERENCES schedules(id) ON DELETE CASCADE,
  employee_id UUID REFERENCES employees(id) ON DELETE CASCADE,
  data DATE NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('mattina', 'pomeriggio', 'full', 'riposo')),
  -- mattina: 09:00-14:00 (5h), pomeriggio: 14:00-20:00 (6h), full: 09:00-20:00 (9h effettive)
  ora_inizio TIME,
  ora_fine TIME,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(schedule_id, employee_id, data)
);

-- Indici
CREATE INDEX ON employees(store_id);
CREATE INDEX ON shifts(schedule_id);
CREATE INDEX ON unavailabilities(schedule_id);
CREATE INDEX ON employees(token);
