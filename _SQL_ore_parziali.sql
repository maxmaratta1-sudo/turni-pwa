-- ─────────────────────────────────────────────────────────────────────────────
-- Feature: Permesso a ore (assenza parziale) — 4 agosto 2026
-- Da eseguire nel SQL Editor di Supabase
-- NOTA: la tabella reale nel codice è `unavailabilities` (non `turni_unavailabilities`).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE unavailabilities ADD COLUMN IF NOT EXISTS ore_parziali INT DEFAULT NULL;
