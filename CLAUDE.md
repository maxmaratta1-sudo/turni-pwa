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
in maia-chat/route.ts) — garantisce sincronia tra generatore e Maia. **Simmetrica** (4
agosto 2026): Romeo alterna mattina/pomeriggio esattamente come Max, stessa logica,
stessa lettura di `alternanza`. Rimossa la regola precedente "Romeo sempre mattina,
scarico merce Lun/Mer/Ven fisso" (era `regola_assoluta` in `turni_config`, ora `null`
per Romeo) — lo scarico merce non è più un vincolo legato a una persona specifica, lo
copre chiunque sia in turno mattina quei giorni. Romeo mantiene però il proprio monte-ore
giornaliero da contratto (28h: 5/4/5/4/5 nei feriali + sabato di aggiustamento 5-6h) — solo
la direzione mattina/pomeriggio segue l'alternanza, non gli orari esatti di Max (30h, 5h/die
fissa Legge 104). **Le assenze di uno dei due non influenzano MAI il turno dell'altro** —
ogni dipendente viene elaborato in un'iterazione indipendente del generatore; l'alternanza
è calcolata una volta a settimana dalla `settimana_riferimento` fissa, mai da "chi ha
coperto cosa" la settimana precedente. Verificato con test end-to-end (agosto 2026, vedi
sotto) e con la rigenerazione completa di Agosto 2026.

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
3. (4 agosto 2026) Romeo era hardcoded a "sempre mattina" nel generatore, ignorando `alternanza` — asimmetrico rispetto a Max, che invece la legge correttamente. Non era il bug "Romeo si sposta per coprire Max" originariamente sospettato (quel pattern non esiste da nessuna parte nel codice — le assenze sono già isolate per dipendente), ma una regola diversa e più vecchia (scarico merce fisico) che Giacomo ha confermato non essere più necessaria. Corretto rendendo simmetrico il ramo Romeo in `generateShiftsMDWeek`, rimossa l'esclusione di Romeo da `correggiChiusura` (pass R7), aggiornato `turni_config` (regola_assoluta → null) e i commenti in `maia-chat/route.ts`. Testato con Max assente reale in produzione (settimana 10-15 agosto): Romeo è rimasto sul turno pomeriggio programmato per tutta la settimana, invariato.

Aggiunto un controllo di sicurezza post-generazione (`verificaBudgetSettimanale` in
generator.ts) che logga un warning se il totale ore settimanale generato non combacia
esattamente con `ore_contratto` — solo diagnostico, non blocca il salvataggio JS.

**Giorni festivi italiani (4 agosto 2026)**: tabella `turni_festivi` (`store_id`, `data`,
`nome`, UNIQUE su store+data) — negozio chiuso, trattati esattamente come la domenica nel
generatore (`generateShiftsMD` in `generator.ts`): tutti riposo, niente assegnazione. Per
Carlo (unico dipendente a distribuzione dinamica delle ore, non a pattern fisso), i festivi
Lun-Ven vengono esclusi dal calcolo di `distribuisciOre` (`distribuisciOreConFestivi`) e le
sue ore si ridistribuiscono sui restanti giorni feriali della settimana — un festivo di
sabato invece lo riguarda come tutti gli altri, perché il sabato non fa parte di quella
redistribuzione dinamica.
TOT settimanale (`manager/page.tsx`): il target per il colore verde/rosso si riduce
esattamente delle ore che il dipendente avrebbe lavorato nei festivi di quella settimana
(cerca lo stesso giorno della settimana in un'altra data del mese senza festivo/assenza,
usa quelle ore come riferimento — esatto nella maggior parte dei casi, dato che i pattern
sono fissi per giorno della settimana). Non maschera ASSENZE REALI non legate al festivo:
testato con Carlo, che quella settimana aveva sia il festivo di sabato SIA un permesso reale
martedì — il TOT resta correttamente rosso per il permesso, il festivo da solo non lo
avrebbe fatto scattare.
Cella tabella: stesso stile della domenica (sfondo viola) + nome breve della festività sotto
la data, cella non cliccabile (negozio chiuso, nessuna modifica manuale).
Maia (`maia-chat/route.ts`): la lista festivi è iniettata nel system prompt — non propone
mai turni in quei giorni.
**SQL eseguito**: `_SQL_festivi.sql` (root del repo) — crea la tabella (FK su `stores`, non
`turni_stores` come nella bozza iniziale) e semina le 12 festività 2026, Pasqua/Pasquetta
verificate con l'algoritmo di Meeus (5-6 aprile).
**Testato in produzione**: rigenerato Agosto 2026 completo — tutti i 13 dipendenti in
riposo il 15 agosto (Ferragosto, che quest'anno cade di sabato), TOT settimanale corretto
per chi non aveva altre assenze, Maia risponde correttamente "negozio chiuso" per il 15
agosto.

**🐛 Bug trovato e corretto — pagina dipendente, conteggio giorni bottone (4 agosto 2026)**:
`src/app/dipendente/[token]/page.tsx` mostrava "Invia N giorni" con N diverso dai giorni
evidenziati in rosso nel calendario. Causa reale (confermata sui dati di produzione, non le
3 ipotesi originali — niente Set duplicato, nessuna data "fantasma" fuori mese): la cella
del calendario dava priorità allo stile "domenica" (grigio) su quello "selezionato" (rosso)
nel ternario di `CalGrid` — un record `unavailabilities` residuo per una domenica (comune:
ogni dipendente in produzione aveva `2026-08-16`, una domenica, già marcato) veniva contato
in `selectedDates.size` ma non renderizzato in rosso, perché la domenica è disabilitata al
click ma non esclusa dal Set caricato da `loadData()`. Stesso rischio latente per i festivi,
non ancora gestiti in questa pagina (mancava del tutto — solo il lato manager li aveva).
Fix: `loadData()` ora filtra domenica E festivi (`turni_festivi`, fetchati per la prima
volta anche qui) fuori da `selectedDates` al caricamento — non solo non selezionabili al
click, ma esclusi a monte dal conteggio anche se già presenti nel DB da prima. Verificato in
produzione (Damiana, agosto 2026): prima del fix aveva 3 record (`2026-08-15` Ferragosto,
`2026-08-16` domenica, `2026-08-31`) — dopo il fix il bottone mostra correttamente "1
giorno" (solo il 31, l'unico realmente selezionabile), e cliccando un altro giorno valido
sale a "2" in sync perfetto con le celle rosse.

**🐛 Bug trovati e corretti — priorità FEST e bordo settimana in editing (4 agosto 2026)**:
1. La cella tabella manager e l'export PDF (Mese e Settimana condividono la stessa funzione
   `exportPDF`) decidevano cosa mostrare controllando PRIMA le assenze (`hasUnavailability`)
   e mai i festivi — un record di assenza residuo su un giorno diventato festivo (scenario
   reale, vedi bug sopra) mostrava P/F/M/R/MT invece di FEST. Fix: controllo festivo ora in
   testa a entrambe le funzioni (priorità: FEST > assenza > turno > riposo), etichetta "FEST"
   viola sia in tabella sia nel PDF.
2. Il bordo blu "settimana in editing" segue `settimanaSelezionata` — dopo `generaSettimana()`
   quello stato non veniva mai resettato, quindi il bordo restava (comportamento in realtà
   coerente col codice, ma non con l'aspettativa: dopo aver generato, si esce dalla modalità
   editing). Fix: `setSettimanaSelezionata('')` dopo una generazione riuscita (resta invariato
   in caso di errore, per poter vedere/riprovare la settimana che ha fallito).
**Non verificato via click nel browser** (pagina manager richiede login email/password reale,
non un secret semplice — nessuna credenziale disponibile, e non ho aggirato il gate scrivendo
`localStorage` manualmente). Verificato solo per revisione di codice: entrambi i fix sono
correzioni dirette e circoscritte, nessuna logica ambigua.
