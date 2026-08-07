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

**Cassiere 22h — 3 mattina + 3 pomeriggio a settimana, sabato invertito (5 agosto 2026)**:
regola confermata con Giacomo, sostituisce il vecchio `PATTERN_COPPIE_22H` (ciclo fisso a 3
giorni sul giorno del mese, scollegato dai confini di settimana e dal sabato — prevedibile,
sempre le stesse coppie in loop). Nuovo algoritmo in `generator.ts`:
1. **Sabato**: `getSabatoPrecedente()` legge dal DB il turno dell'ultimo sabato salvato per
   quel dipendente (query diretta per `data`, indipendente da quale mese/schedule appartiene
   — la data è una chiave di calendario globale) e lo inverte. Prima settimana in assoluto
   (nessun sabato precedente in DB) → seed fisso 2+2 (`SEED_SABATO_22H`). L'inversione
   garantisce per induzione il 2+2 di sabato automaticamente: se la settimana N ha 2+2, la
   settimana N+1 (tutte invertite) ha ancora 2+2.
2. **Lun-Ven**: `distribuisciCassiere22Settimana()` — dato il fabbisogno residuo di ciascuna
   (2 mattina se sabato=mattina, 3 se sabato=pomeriggio, e viceversa per il pomeriggio),
   distribuisce giorno per giorno forzando le scelte quando il fabbisogno residuo coincide
   coi giorni rimasti (altrimenti sforerebbe), scegliendo a caso (shuffle, `Math.random()`)
   tra le libere per il resto. Questa è la "randomizzazione controllata" richiesta — le
   coppie variano da sola conseguenza dello shuffle, nessuno storico coppie tracciato
   esplicitamente (variabilità strutturale, non per design esplicito anti-ripetizione).
3. Entrambi calcolati UNA VOLTA a settimana (cache ancorata al lunedì, `cassiere22Cache`,
   stesso meccanismo di `alternanzaCache`/`pianoSettimanale` già in uso per Max/Romeo/Carlo)
   e riusati per tutti i giorni e tutte le cassiere di quella settimana.
**Aggiornato `turni_config.regole_generali.cassiere_22h_copertura.regola`** in Supabase con
la nuova regola precisa (3+3, sabato invertito, coppie variabili) — altri campi esistenti
dell'oggetto preservati.
**✅ Testato in produzione**: rigenerate 3 settimane consecutive di agosto (10-15, 17-22,
24-29 — la settimana 31 ago-5 set esclusa dal test perché a cavallo tra due mesi, limite
del test non del generatore). Verificato su dati reali: 2+2 esatto ogni singolo giorno delle
3 settimane (18 giorni, sabati inclusi); sabato invertito perfettamente tra settimana 2 e 3
per tutte e 4 (unica coppia di sabati "pulita" nel test, la settimana 1 aveva sabato 15
agosto = Ferragosto/festivo, quindi riposo per tutte, correttamente); 3+3 esatto nelle
settimane 2 e 3 (22h a testa), settimana 1 a 17h per tutte per via del sabato festivo
(5+3+... coerente, non un bug); coppie mattina variate tra le settimane — comparse coppie
nuove in settimana 3 mai viste nelle settimane 1-2, a conferma che non è più un ciclo fisso.
⚠️ I turni generati durante questo test sono rimasti salvati come dati reali di produzione
per queste 4 dipendenti in queste 3 settimane (sovrascritti i turni precedenti) — non erano
dati fittizi, il risultato è corretto secondo la nuova regola quindi non sono stati annullati.

---

## Sconto ore festivi (tabella fissa) + fascia centrale 12-14 + pannello Mezzogiorno (6 agosto 2026)

**Sconto ore festivo — sostituita la vecchia logica** (mancante per i dipendenti a
pattern fisso, "ridistribuzione a budget pieno" per Carlo/22h — vedi verifica del 5 agosto
2026 sopra, che aveva trovato discrepanze reali su tutti i contratti). Nuova regola
confermata da Max: sconto FISSO dal target settimanale per ogni festivo (feriale o sabato,
indipendentemente da quante ore varrebbe normalmente quel giorno specifico):
```
22h → 3h    28h → 4h    30h (Max) → 5h    35h → 5h    36h → 6h    40h → 6h
```
(`SCONTO_FESTIVO_PER_CONTRATTO`, `generator.ts`). Rimossa `distribuisciOreConFestivi`
("budget pieno non scende per colpa del festivo") — `getPianoGiorno` (Carlo, cassiere 22h)
ora distribuisce le ore come se non ci fosse mai un festivo (esattamente come tutti gli
altri dipendenti a pattern fisso), e una nuova funzione `applicaScontoFestivi()` (pass
post-generazione, stesso pattern di `correggiChiusura`) applica lo sconto a TUTTI i
dipendenti uniformemente: per ogni settimana con almeno un festivo, confronta il totale
generato con l'atteso (`ore_contratto - sconto×numero_festivi`) e corregge la differenza
allungando/accorciando UN turno mattina/pomeriggio "normale" quella settimana (mai i turni
a orario fisso vincolato — Yuri 13-16 obbligatorio, Max Legge 104 mai oltre 5h/giorno — che
restano fuori perché hanno tipo `yuri_full`/`yuri_pomeriggio`/`mattina_corta`/
`pomeriggio_corto`, non `mattina`/`pomeriggio`). `verificaBudgetSettimanale` aggiornata per
non dare più falsi allarmi nelle settimane con festivo (target atteso ora tiene conto dello
sconto).
**✅ Testato in produzione** (funzione pura, nessuna scrittura — festivo di test inserito,
generato, poi rimosso): sabato di Ferragosto (2026-08-15, reale) e un festivo
infrasettimanale di test (mercoledì 2026-09-09) — **discrepanza 0 per tutti i 13
dipendenti attivi, entrambi gli scenari**, tabella rispettata esattamente indipendentemente
da quante ore varrebbe normalmente il giorno colpito (es. sabato Ferragosto per le 22h
scala solo 3h, non le 5h che varrebbe normalmente quel sabato — verificato).
⚠️ **Nota tecnica trovata durante il test**: il client Supabase condiviso (`supabaseAdmin`)
sembra avere risposte GET cache-ate da Next.js anche su route `force-dynamic` quando una
insert e una successiva lettura avvengono nella STESSA request (osservato: dati non
aggiornati/stale subito dopo un insert). Non ha impatto sul flusso reale (nell'app,
aggiungere un festivo e generare i turni sono sempre due request separate), ma se in futuro
si scrive codice che legge subito dopo aver scritto nella stessa request, usare un client
dedicato con `fetch: (url, opts) => fetch(url, {...opts, cache: 'no-store'})` invece del
`supabaseAdmin` condiviso.

**Fascia centrale 12:00-14:00 — minimo 2 cassieri.** Yuri (`presenza_preferita` in config)
copre già 13-16 quasi tutti i giorni ma questo da solo non copre l'intera fascia (Mar/Gio fa
solo 13/16, manca 12-13) — serve sempre almeno un'altra cassiera con un turno "centrale" che
copra 12-14 per intero (10/14, 11/15, 09/14, ecc.). Nuova funzione `correggiFasciaCentrale()`
(stesso pattern di `correggiChiusura`, post-generazione): se il conteggio di chi si
sovrappone alla fascia (anche parzialmente) è sotto il minimo, converte il turno di una
cassiera candidata (mai Yuri, mai `non_cassiere`, mai flessibilità "Nessuna") in un orario
centrale valido cercato in `config.legenda_orari` (stesse ore del turno originale quando
possibile, altrimenti ±1/±2h entro il `max_ore_giorno`), preservando l'esclusione dei
giorni festivi/domenica (nessun falso warning nei giorni di chiusura). Config aggiornata:
`regole_generali.fascia_centrale_obbligatoria` (`inizio`, `fine`, `minimo_cassieri: 2`,
`presenza_preferita: "Yuri"`).
**✅ Testato in produzione**: verificata copertura ≥2 persone su tutti i giorni lavorativi
di una settimana reale (7-12 settembre), festivi/domenica correttamente esclusi dal check.

**Pannello "🕐 Mezzogiorno"** (`manager/page.tsx`) — stesso pattern UI del pannello
"🔒 Chiusure" (pannello laterale destro, navigazione settimana con frecce ←/→). Per ogni
giorno mostra chi si sovrappone alla fascia 12-14 (criterio identico al pannello Chiusure:
qualunque sovrapposizione, non necessariamente copertura piena — coerente con l'esempio
"Yuri (13/16) — solo 1 persona" fornito da Max), verde se ≥2 persone, rosso/warning se 0-1.

---

## 3 fix richiesti da Giacomo — emergenze ore extra, REC vs R, menu orari completo (7 agosto 2026)

### FIX 1 — Maia confermava ma salvava l'orario SBAGLIATO per turni emergenziali

**🐛 Root cause reale (diversa dall'ipotesi iniziale)**: il sospetto era che
`verificaBudgetSettimanale` bloccasse silenziosamente i comandi emergenziali — risultava
parzialmente vero (il controllo NON aveva alcun bypass per comandi espliciti, vedi fix
sotto), ma il bug concretamente riprodotto con "metti Damiana 8/15 martedì" era un altro:
**`oreToShiftType()`** (usata da `upsertShift` per mappare `ore` esplicite → orario reale)
gestiva esplicitamente solo `ore === 3/4/5`, e per QUALSIASI altro valore (6, 7, 8...)
cadeva sempre nel default fisso `08:00-14:00` (mattina) o `14:00-20:00` (pomeriggio),
**ignorando silenziosamente il valore di "ore" richiesto**. Con 6h il default coincideva
per puro caso col valore corretto (mascherando il bug), ma con 7h (il caso di Damiana)
veniva troncato a 6h — Maia rispondeva "✅ Fatto, 08:00-15:00" ma il DB salvava
`08:00-14:00`. Non un fallimento di salvataggio silenzioso, ma un **salvataggio sbagliato
con conferma comunque positiva** — stesso sintomo riportato da Giacomo (l'orario reale non
corrispondeva a quanto richiesto), causa diversa da quella ipotizzata.
**Fix**: `oreToShiftType()` ora calcola dinamicamente `08:00 + ore` (mattina) o
`20:00 - ore` (pomeriggio) per qualsiasi valore oltre 3/4/5, non solo il caso standard da
6h. ⚠️ **Limite noto, non risolto qui** (fuori scope del bug segnalato): il parametro
"ore" non può rappresentare un orario con un INIZIO non standard (es. "10/17" verrebbe
letto come ore=7 e assunto 08:00-15:00, non 10:00-17:00) — servirebbe estendere lo schema
del tool con `ora_inizio`/`ora_fine` espliciti invece di solo "ore" per coprire anche
quel caso; il caso testato e riportato da Giacomo ("8/15") è ancorato a 08:00 quindi
funziona correttamente col fix attuale.

**Secondo problema reale, anche questo confermato**: `verificaBudgetSettimanale` non aveva
MAI un bypass per comandi emergenziali — qualsiasi sforamento del budget settimanale
veniva bloccato con un errore, anche con "ore" esplicito passato da Giacomo. Fix: nuovo
parametro `isEmergenza` — in `update_shift`, la sola presenza di `input.ore` (sempre
esplicito lì, mai calcolato automaticamente) è già la firma di un comando emergenziale; in
`update_shift_week` va invece distinto dall'`oreOverride` finale (che può anche essere
calcolato automaticamente per Cristina/Stefania) — solo l'`ore` ESPLICITO di Giacomo
(`oreEsplicite`) marca `isEmergenza`, mai il valore auto-calcolato.

**Terzo intervento — veridicità delle conferme**: aggiunta la sezione "EMERGENZE — ORE
EXTRA" al system prompt (testo fornito da Giacomo) più una nuova regola esplicita
"REGOLA ASSOLUTA SULLA VERIDICITÀ DELLE CONFERME" — Maia non deve mai dire "fatto" se il
risultato del tool inizia con "Errore" o segnala un fallimento in qualsiasi forma.

**Quarto intervento — logging (STEP 3)**: `console.error` esplicito su ogni fallimento
reale di `upsertShift` in `update_shift`/`update_shift_week` (prima passava inosservato,
il giorno veniva semplicemente saltato senza traccia); `update_shift_week` ora conta
anche i fallimenti di salvataggio separatamente dai giorni bloccati per budget e lo
segnala esplicitamente nella risposta invece di ometterlo. Aggiunto anche un log
diagnostico temporaneo (`[maia-chat] update_shift(_week) input: ...`) che stampa i
parametri esatti ricevuti dal tool — è stato proprio questo log a rivelare la root cause
reale (ore=7 richiesto, ma orario salvato 08:00-14:00/6h) durante il test.

**✅ Testato in produzione con dati reali** (non solo teoria): comando reale a Maia
("metti Damiana 8/15 martedì 11 agosto") sulla settimana 10-15 agosto — **primo test
fallito** (turno salvato 08:00-14:00 invece di 08:00-15:00, root cause trovata via log
diagnostico), **secondo test dopo il fix di `oreToShiftType` riuscito**: turno
effettivamente salvato in tabella `08:00:00 → 15:00:00` (7h), verificato leggendo
direttamente il DB con un client no-store (vedi nota sotto), non solo la risposta di
Maia. Testato anche uno scenario di sforamento del budget SETTIMANALE (12h in un giorno,
totale settimana 24h > 22h contratto) → confermato e salvato correttamente, bypass
funzionante. Dati di test ripristinati allo stato originale dopo la verifica.

**⚠️ Nota tecnica riscontrata durante il test**: stesso bug di caching Next.js già
documentato in mangia-pwa2/CLAUDE.md (Flow 12/notification_retry_queue) — una route di
debug con client Supabase condiviso (senza `cache: "no-store"` esplicito) restituiva dati
stale anche dopo un salvataggio reale avvenuto poco prima. Il client `supabaseAdmin`
condiviso di questo repo (`src/lib/supabase.ts`) NON ha il fix no-store — se in futuro si
scrive un endpoint che deve leggere dati appena scritti (anche in una request separata),
usare un client dedicato con `fetch: (url, opts) => fetch(url, {...opts, cache: "no-store"})`
invece del client condiviso, come già fatto in più punti di mangia-pwa2.

### FIX 2 — Differenziare Riposo da Recupero (REC vs R)

Il DB continua a salvare `"R"` in `tipo_assenza` (nessuna migrazione dati, compatibilità
piena con dati storici) — cambia SOLO la lettera mostrata: nuova funzione
`getAssenzaDisplay(code)` (`manager/page.tsx`) mappa `"R"` → `"REC"` (identità per tutti
gli altri codici), usata sia nella cella tabella sia nella riga esportata nel PDF
(jsPDF/autoTable, `row.push(getAssenzaDisplay(getAssenzaCode(...)))`). Legenda sotto la
tabella aggiornata: `REC = Recupero` invece di `R = Recupero`. Stessa disambiguazione
applicata a: risposte testuali di Maia (`maia-chat/route.ts`, sia il messaggio di
conferma `update_shift` col recupero domenicale sia quello di `set_assenza`), tool
description del parametro `tipo_assenza` (istruzione esplicita a Claude di dire sempre
"REC" e mai "R" da sola parlando con Giacomo), `bridge/route.ts` (usato da
`maia-turni.ts` in mangia-pwa2), e il dropdown "Tipo assenza" della pagina self-service
dipendente (`dipendente/[token]/page.tsx`) — in tutti i casi il `value`/codice DB resta
`"R"`, cambia solo l'etichetta visibile.
Il Riposo normale non ha mai avuto una lettera propria (cella vuota o turno normale, non
un'assenza) — non richiedeva alcuna modifica.

### FIX 3 — Menu a cascata: stessi orari per tutti, completo e ordinato

`getOrariValidi()` non filtra più per `oreSettimanali` — ritorna sempre la stessa lista
`TUTTI_GLI_ORARI` (29 orari + `'—'` per riposo) per qualsiasi dipendente MD, ordinata
cronologicamente per inizio poi fine, con i 4 nuovi orari richiesti (`8/15`, `10/16`,
`11/17`, `12/16`) inclusi. Il parametro `oreSettimanali` resta nella firma della funzione
(non più usato) per non toccare il call site esistente. `parseOrarioSelezionato()` (invariata)
già gestiva qualsiasi stringa "HH/HH" in modo generico — nessuna modifica necessaria lì,
funziona automaticamente con la lista estesa. Il vincolo di contratto resta attivo SOLO
per la generazione automatica (`generator.ts`, non toccato da questo fix), mai per la
selezione manuale dal popup.

**⚠️ Non verificato via click nel browser** — la pagina manager richiede login
email/password reale, nessuna credenziale disponibile (stesso limite già documentato più
sopra in questo file per un fix precedente). Verificato via revisione di codice: modifica
a basso rischio (array letterale + funzione a un'unica riga), typecheck pulito, logica di
parsing dell'orario (`parseOrarioSelezionato`) già generica e non toccata.
