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
- Il generatore Stroili (default) usa un algoritmo greedy basato su ore rimanenti/giorni rimanenti — invariato
- RLS Supabase: da configurare (per ora service role per tutto)
- Repo: maxmaratta1-sudo/turni-pwa

## MD Lanciano — generatore config-driven (v2, agosto 2026)

Per lo store MD Lanciano, `src/lib/generator.ts` (`generateShiftsMD`/`generateShiftsMDWeek`)
NON usa più costanti hardcoded — legge le regole da `turni_config` (tabella Supabase,
colonna `config` JSONB, una riga per `store_id`), la STESSA fonte di verità già letta da
Maia (`src/app/api/maia-chat/route.ts`). Il generatore carica la config una volta per
chiamata, non ad ogni assegnazione.

**Alternanza Max/Romeo**: letta da `turni_alternanza` (stesso meccanismo di `chiMattina`
in maia-chat/route.ts) — garantisce sincronia tra generatore e Maia.

**Bug corretto — `getWeekIndex` confine di settimana**: `getWeekIndex` calcola i confini
di settimana a blocchi di 7 giorni dal 1° gennaio, che nel 2026 è un giovedì — quindi
l'indice cambiava tra mercoledì e giovedì, non tra domenica e lunedì. Sia `generator.ts`
(`getMonday` + ancoraggio della cache dell'alternanza al lunedì) sia `chiMattina` in
`maia-chat/route.ts` (stesso fix, applicato direttamente dentro la funzione: `getWeekIndex`
riceve sempre `toDateStr(getMonday(...))` invece della data grezza) ora ancorano SEMPRE il
calcolo al lunedì della settimana, indipendentemente dal giorno passato. Verificato con un
test dal vivo (agosto 2026): generata la settimana 3-8 agosto col generatore, poi chiesto a
Maia "chi fa mattina, Max o Romeo?" simulando la domanda sia di giovedì (6 agosto) sia di
sabato (8 agosto) — risposta identica ("Romeo mattina, Max pomeriggio") e coerente con i
turni effettivamente salvati in entrambi i casi.

**Alternanza sabato (Cristina, Carlo, Denise)**: nessuna tabella dedicata come
`turni_alternanza` — usa un'ancora fissa hardcoded in `generator.ts`
(`SABATO_ANCORA = '2026-08-08'`, direzione di partenza scelta arbitrariamente per ciascuno).
Da confermare con Giacomo; se la direzione reale di quel sabato è diversa, invertire il
valore in `SABATO_ANCORA_DIREZIONE`.

**Claude Opus 5 (opt-in)**: `POST /api/shifts/generate-week` accetta `use_opus: true` nel
body — genera con `claude-opus-5` (`src/lib/generateWithOpus.ts`), valida l'output contro
i vincoli hard (`src/lib/validateShifts.ts`: budget esatto, max_ore_giorno, copertura
chiusura, fascia obbligatoria, Cristina/Stefania mai stesso turno), e se la validazione
fallisce torna automaticamente al generatore JS invece di salvare dati inconsistenti
(risposta include `engine: "opus"|"js"` e `opus_validation_errors`). Default `use_opus`
assente/false — il bottone "⚡ Genera turni"/"⚡ Genera settimana" in manager/page.tsx non
usa Opus finché non viene esplicitamente collegato in UI (decisione non presa qui).
**Testato**: al primo giro l'output di Opus ha violato più vincoli (budget, copertura,
fascia) — la validazione li ha rilevati tutti correttamente e il fallback JS ha salvato
dati validi. Il prompt di Opus può essere raffinato in un giro successivo.

**Bug trovati e corretti durante il test (agosto 2026)**:
1. Alternanza Max/Romeo che cambiava a metà settimana (vedi bug `getWeekIndex` sopra) — corretto ancorando al lunedì lato generatore.
2. Sabato delle cassiere 22h con inizio mattina flessibile (08/09/10/11) accorciava la durata del turno invece di spostare solo l'inizio (durata = 13:00 − inizio invece di 5h fisse) — corretto fissando la durata a 5h e lasciando variare solo l'orario di inizio.

Aggiunto un controllo di sicurezza post-generazione (`verificaBudgetSettimanale` in
generator.ts) che logga un warning se il totale ore settimanale generato non combacia
esattamente con `ore_contratto` — solo diagnostico, non blocca il salvataggio JS.
