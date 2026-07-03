# TURNI PWA — Context per Claude Code

## Progetto
PWA per gestione turni settimanali/mensili per negozi retail.
Cliente pilota: Adele — Stroili Oasi Lanciano.

## Stack
- Next.js 14 (App Router) + TypeScript
- Supabase (DB + Auth)
- Vercel (deploy)
- Deploy: `npx vercel --prod`

## Struttura turni
- Mattina: 09:00–14:00 (5h)
- Pomeriggio: 14:00–20:00 (6h)
- Full: 09:00–20:00 (9h effettive con pausa)
- Riposo

## Contratti dipendenti
- 20h settimanali → ~87h mensili
- 30h settimanali → ~130h mensili
- 40h settimanali → ~173h mensili

## Flusso
1. Manager crea piano mese
2. Ogni dipendente accede via link token personale → segna indisponibilità
3. Manager genera turni automaticamente (algoritmo in src/lib/generator.ts)
4. Manager aggiusta manualmente se serve → pubblica
5. Dipendenti vedono i propri turni

## Env vars necessari
- NEXT_PUBLIC_SUPABASE_URL
- NEXT_PUBLIC_SUPABASE_ANON_KEY
- SUPABASE_SERVICE_ROLE_KEY
- NEXT_PUBLIC_STORE_ID (ID del negozio in Supabase)
- MANAGER_SECRET (password accesso pagina manager)

## Note
- Domenica: negozio chiuso (da confermare con Adele)
- Il generatore usa un algoritmo greedy basato su ore rimanenti/giorni rimanenti
- RLS Supabase: da configurare (per ora service role per tutto)
- Repo: maxmaratta1-sudo/turni-pwa
