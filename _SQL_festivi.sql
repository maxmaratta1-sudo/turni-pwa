-- ─────────────────────────────────────────────────────────────────────────────
-- Feature: Giorni festivi italiani — negozio chiuso, escluso da budget ore (4 agosto 2026)
-- Da eseguire nel SQL Editor di Supabase
-- NOTA: la tabella reale nel codice è `stores` (non `turni_stores`) — corretto qui.
-- Pasqua/Pasquetta 2026 verificate: 5-6 aprile (calcolate con l'algoritmo di Meeus).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS turni_festivi (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID REFERENCES stores(id) ON DELETE CASCADE,
  data DATE NOT NULL,
  nome TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(store_id, data)
);

-- Festività italiane 2026 per MD Lanciano
INSERT INTO turni_festivi (store_id, data, nome) VALUES
  ((SELECT id FROM stores WHERE nome = 'MD Lanciano'), '2026-01-01', 'Capodanno'),
  ((SELECT id FROM stores WHERE nome = 'MD Lanciano'), '2026-01-06', 'Epifania'),
  ((SELECT id FROM stores WHERE nome = 'MD Lanciano'), '2026-04-05', 'Pasqua'),
  ((SELECT id FROM stores WHERE nome = 'MD Lanciano'), '2026-04-06', 'Pasquetta'),
  ((SELECT id FROM stores WHERE nome = 'MD Lanciano'), '2026-04-25', 'Liberazione'),
  ((SELECT id FROM stores WHERE nome = 'MD Lanciano'), '2026-05-01', 'Festa del Lavoro'),
  ((SELECT id FROM stores WHERE nome = 'MD Lanciano'), '2026-06-02', 'Festa della Repubblica'),
  ((SELECT id FROM stores WHERE nome = 'MD Lanciano'), '2026-08-15', 'Ferragosto'),
  ((SELECT id FROM stores WHERE nome = 'MD Lanciano'), '2026-11-01', 'Ognissanti'),
  ((SELECT id FROM stores WHERE nome = 'MD Lanciano'), '2026-12-08', 'Immacolata'),
  ((SELECT id FROM stores WHERE nome = 'MD Lanciano'), '2026-12-25', 'Natale'),
  ((SELECT id FROM stores WHERE nome = 'MD Lanciano'), '2026-12-26', 'Santo Stefano')
ON CONFLICT (store_id, data) DO NOTHING;
