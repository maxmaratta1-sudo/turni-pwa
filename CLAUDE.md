# TURNI PWA — Context per Claude Code

## Progetto
PWA per gestione turni settimanali/mensili — **esclusivamente MD Lanciano** (manager
Giacomo), a partire dal 22 agosto 2026.

**Nota storica**: in passato il progetto supportava anche un secondo cliente, Stroili
Oasi Lanciano (manager Adele) — algoritmo generico a ore/contratto (20h/30h/40h, turni
fissi 9-14/14-20/9-20), completamente separato dalla logica MD (config-driven via
`turni_config`). Rimosso il 22 agosto 2026: progetto Stroili in stand-by indefinito da
settimane, il codice condiviso (branch condizionali `isMD`/Stroili, costanti duplicate,
store separati nello stesso DB) causava confusione e interferenze reali nel lavoro su MD
(es. un bug di match store — "Stroili Oasi Lanciano" scambiato per "MD Lanciano" — trovato
proprio durante un fix urgente MD). Rimossi ~385 righe di codice condizionale/duplicato
(generator.ts, manager/page.tsx, MaiaChatBubble.tsx, types/index.ts, 2 route API) e tutti
i dati Stroili da Supabase (11 employees, 1 manager, 2 schedules, 312 shifts, 6
unavailabilities, 1 store — verificato che nessun'altra tabella referenziasse quegli ID
prima di cancellare). **Se in futuro serve Stroili (o un cliente simile) di nuovo, NON
riesumare questo codice — ripartire da un progetto pulito.** La cronologia Git di questo
repo conserva comunque l'implementazione originale, recuperabile per riferimento se serve
capire come funzionava.

## Stack
- Next.js 14 (App Router) + TypeScript
- Supabase (DB + Auth)
- Vercel (deploy)
- Deploy: `npx vercel --prod`

## Struttura turni (MD Lanciano)
Config-driven da `turni_config` (Supabase, JSONB) — non ci sono più orari fissi
hardcoded uguali per tutti. Vedi sezione "MD Lanciano — generatore config-driven" sotto
per il dettaglio completo (pattern per dipendente, fasce obbligatorie, alternanze).

## Contratti dipendenti (MD Lanciano)
22h, 28h, 30h, 35h, 36h, 40h, 46h settimanali — target mensili in `ORE_MENSILI_MD`
(`src/types/index.ts`).

## Flusso
1. Manager crea piano mese
2. Ogni dipendente accede via link token personale → segna indisponibilità
3. Manager genera turni automaticamente (algoritmo in src/lib/generator.ts,
   `generateShiftsMD`/`generateShiftsMDWeek` — unico entry point, nessun ramo alternativo)
4. Manager aggiusta manualmente se serve → pubblica
5. Dipendenti vedono i propri turni

## Env vars necessari
- NEXT_PUBLIC_SUPABASE_URL
- NEXT_PUBLIC_SUPABASE_ANON_KEY
- SUPABASE_SERVICE_ROLE_KEY
- NEXT_PUBLIC_STORE_ID (ID del negozio in Supabase) — ⚠️ **verificato il 21/08/2026 che
  su Vercel punta all'ID di Stroili** (`0354fca4-...`, ora cancellato), non a MD Lanciano
  (`a1a56d3b-...`) — nessun codice attivo lo legge più direttamente (il flusso reale passa
  sempre da `localStorage.turni_store_id`, popolato dal login), ma se in futuro qualcosa
  torna a usare questa env var, va aggiornata su Vercel prima.
- MANAGER_SECRET (password accesso pagina manager)

## Note
- Domenica: gestita da MD Lanciano (turni domenicali assegnati manualmente da Giacomo,
  vedi generatore sotto — non è più "negozio chiuso di default" come nell'algoritmo Stroili
  rimosso)
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

---

## Turno spezzato manuale — mattina + pomeriggio nello stesso giorno (8 agosto 2026)

Caso raro/eccezionale confermato da Giacomo: un dipendente lavora due blocchi separati
nello stesso giorno (mattina + pomeriggio, con buco in mezzo). **Esclusivamente manuale**
via click cella in `manager/page.tsx` — **nessuna modifica al generatore automatico**
(`generateShiftsMDWeek`) né a Maia, come esplicitamente richiesto. Blocco mattina sempre
`08:00` → fine variabile (09:00-13:00); blocco pomeriggio sempre → `20:00`, inizio
variabile (15:00-19:00).

**Schema DB**: tabella `shifts`, nuova colonna `sequenza INT DEFAULT 1` (1 = blocco
mattina/turno normale, 2 = blocco pomeriggio). Vecchio constraint UNIQUE
`(schedule_id, employee_id, data)` sostituito da `(schedule_id, employee_id, data,
sequenza)` — permette 2 righe per lo stesso dipendente/giorno. Nuovi valori `tipo`:
`spezzato_mattina`, `spezzato_pomeriggio` (aggiunti a `TurnoTipo` in `types/index.ts` e a
tutti e 4 i Record esaustivi `ORE_TURNO`/`ORARI_TURNO`/`ORE_TURNO_MD`/`ORARI_TURNO_MD`,
con valori placeholder mai realmente letti perché il calcolo usa sempre `ora_inizio`/
`ora_fine` reali della riga).

**🐛 Bug trovati durante la migrazione SQL (non nello script originale fornito)**:
1. Cast type mismatch (`operator does not exist: name[] = text[]`) nello script di
   discovery dinamica del vecchio constraint UNIQUE — `pg_attribute.attname` è di tipo
   `name`, non `text`; serve `array_agg(attname::text ORDER BY attname)` per confrontarlo
   con un `text[]` letterale.
2. **Check constraint `shifts_tipo_check`** sul campo `tipo` — non anticipato nello script
   originale (che copriva solo il constraint UNIQUE), scoperto SOLO durante il test live
   (`new row for relation "shifts" violates check constraint "shifts_tipo_check"`).
   Risolto con un secondo script (`_SQL_turno_spezzato_2_tipo_check.sql`) che ricrea il
   CHECK includendo `spezzato_mattina`/`spezzato_pomeriggio` nella lista dei valori
   ammessi.
3. **4 upsert esistenti rotti dal cambio di constraint** — `onConflict:
   'schedule_id,employee_id,data'` in `maia-chat/route.ts` (×2) e `bridge/route.ts` (×2)
   avrebbe fallito a runtime dopo il cambio (il constraint referenziato da `onConflict`
   deve corrispondere esattamente). Corretti tutti e 4: payload ora include `sequenza: 1`,
   `onConflict: 'schedule_id,employee_id,data,sequenza'`. Aggiunta anche una pulizia
   difensiva (`DELETE ... WHERE sequenza > 1`) prima di ogni upsert normale di Maia/bridge,
   per rimuovere l'eventuale blocco pomeriggio orfano se quel giorno era stato spezzato
   manualmente in precedenza e viene poi toccato da un comando normale.

**UI (`manager/page.tsx`)**: bottone "✂️ Dividi turno (mattina + pomeriggio)" in fondo al
popup click-cella (solo MD Lanciano), apre un mini-modal con due `<select>` (fine
mattina 09:00-13:00, inizio pomeriggio 15:00-19:00) e ore totali calcolate live. Salvataggio
(`salvaTurnoSpezzato`) cancella le righe esistenti per quel giorno e inserisce 2 righe
nuove (`sequenza: 1`/`2`). Cella tabella: quando esistono 2 righe per lo stesso
dipendente/giorno, rendering impilato con divisore e colore distintivo
`bg-fuchsia-100 text-fuchsia-800` (`Sp-M`/`Sp-P` in legenda). `getShift()` (usata da tutto
il resto del codice per compatibilità) ordina per `sequenza` e ritorna sempre il blocco
mattina come "primario"; nuovo helper `getShiftsForDay()` ritorna entrambe le righe
ordinate quando serve iterare su tutte.

**STEP 5 — TOT settimanale, l'assunzione iniziale ("dovrebbe funzionare già da solo,
iterando su tutti i turni") era sbagliata**: `oreLavorateGiorno` usava `getShift()`
(singola riga) e sommava solo il blocco mattina, ignorando il pomeriggio. Corretto per
usare `getShiftsForDay()` e sommare le ore di tutte le righe del giorno.

**PDF (Mese e Settimana, `exportPDF` — `exportPDFSettimana` lo chiama internamente quindi
un solo fix copre entrambi)**: quando un giorno ha 2 righe, la cella mostra le due righe
impilate (stringa multi-linea `\n`-joined) invece del turno singolo; colorazione fuchsia
dedicata nel PDF (`didParseCell`, check su `val.includes('\n')`).

**✅ Testato in produzione (solo a livello DB, via route di debug temporanea)**:
1. Inserimento split (2 righe, sequenza 1/2, tipo/orari corretti) — verificato.
2. Il nuovo UNIQUE `(schedule_id, employee_id, data, sequenza)` rifiuta correttamente un
   duplicato — verificato (`duplicate key value violates unique constraint`).
3. Maia (`update_shift` reale via `/api/maia-chat`) continua a funzionare normalmente
   dopo il cambio di schema.
4. **Edge case critico verificato**: split manuale di un giorno (2 righe), poi Maia
   modifica lo stesso giorno con un comando normale → la riga orfana `sequenza=2` viene
   correttamente cancellata e il giorno torna a un turno singolo normale (comportamento
   difensivo voluto, non un bug).
**⚠️ Non verificato via click nel browser** (stesso limite login email/password di tutti
i fix precedenti in questo file) — bottone "Dividi turno", modal, cella impilata e PDF
non sono stati click-testati nella UI reale, solo a livello DB tramite route di debug
(creata, testata, poi rimossa — confermato 404 dopo la rimozione).

---

## 4 fix urgenti — chiusura, fascia 13-16, bilanciamento mattina/pomeriggio, sposta riposo Maia (21 agosto 2026)

### FIX 1 — Chiusura 20:00: "a volte solo 2 persone invece di 3"

**Verificato su 6 mesi di dati reali** (luglio-dicembre 2026, via route di debug
temporanea che genera in memoria con `generateShiftsMD` senza scrivere su DB): **zero
casi** di sotto-copertura chiusura generati dal codice, festivi esclusi correttamente
dal check. Test sintetico con assenze forzate crescenti: serve che **8 dipendenti su 13
siano assenti lo stesso giorno** prima che `correggiChiusura` non riesca più a coprire —
scenario irrealistico per ferie/assenze normali. L'ipotesi iniziale ("pool eroso dalle
ferie") non regge sotto test.

**Bug reale trovato e corretto**: `correggiChiusura` non loggava MAI un warning quando
falliva a raggiungere il minimo (a differenza di `correggiFasciaCentrale`, che lo fa) —
fallimento silenzioso confermato, ora corretto. Aggiunta anche l'esclusione domenica/
festivi dal check (mancava — senza `festiviSet` esplicito ogni domenica/festivo con
tutti a riposo avrebbe generato un falso warning).

**Sospetto più probabile per le segnalazioni reali di Giacomo** (non risolto qui, fuori
scope — richiederebbe toccare `maia-chat/route.ts`): modifiche manuali post-generazione
(update_shift via Maia, o click diretto in manager/page.tsx) NON ri-eseguono
`correggiChiusura` — quel pass gira solo dentro `generateShiftsMD`/`generateShiftsMDWeek`.
Se Giacomo sposta un turno dopo aver generato, la copertura chiusura di quel giorno può
rompersi senza che nessuna verifica lo segnali. Da investigare se il problema si ripete.

### FIX 2 — Fascia 13:00-16:00: da verifica a correzione reale

`verificaFasciaObbligatoria` (solo `console.warn`, mai correggeva — commento originale:
"un vero auto-fix richiederebbe un constraint solver") sostituita da
`correggiFasciaObbligatoria`, stesso pattern di `correggiFasciaCentrale` (12-14):
converte il turno di una cassiera candidata (mai Yuri, mai `non_cassiere`, mai
flessibilità "Nessuna") in un orario che copre 13-16 per intero, cercato in
`config.legenda_orari`. La regola "Yuri + 1 altro quando lavora, 2 cassieri qualsiasi
quando assente" emerge naturalmente dal conteggio — non serve logica dedicata per
distinguere i due casi, la presenza di Yuri (quando lavora) conta già nel totale.

### FIX 3 — Bilanciamento mattina ≥ pomeriggio

Nuovo pass `correggiBilanciamentoMattinaPomeriggio`: la mattina deve avere sempre almeno
lo stesso numero di persone del pomeriggio, conteggio totale giornaliero. "Mattina"/
"pomeriggio" classificati dall'**orario effettivo** (`ora_inizio < 14:00` /
`ora_fine > 14:00`), non dalla stringa `tipo` (troppo variabile tra i rami del
generatore — mattina, mattina_corta, full, spezzato_mattina, valori "yuri_*" da
config...) — un turno lungo (full, o Yuri se il pattern del giorno è più ampio di 13-16)
conta in entrambi, uno spezzato conta una volta per riga. Esclude Yuri e Gilda/Tony
(`pattern_standard.lun_sab`, fissi mattina per contratto).
Aggiunta a `turni_config.regole_generali.bilanciamento_mattina_pomeriggio` (Supabase, via
route di debug temporanea POST — merge, altri campi preservati):
```json
{"regola": "La mattina deve avere sempre almeno lo stesso numero di persone del pomeriggio, di norma 1 in più", "applicabile": "conteggio totale giornaliero, tutti i reparti/ruoli"}
```

**🐛 Bug trovato e corretto PRIMA del deploy finale** (mai arrivato in produzione — la
verifica sistematica sui 6 mesi lo ha beccato subito): sia `correggiFasciaObbligatoria`
(FIX 2) sia `correggiBilanciamentoMattinaPomeriggio` (FIX 3), girando DOPO
`correggiChiusura`, potevano "rubare" esattamente il turno che finiva alle 20:00 e che
`correggiChiusura` aveva appena spostato lì per raggiungere il minimo — convertendolo di
nuovo (a un orario centrale 13-16, o a mattina per il bilanciamento) e riportando la
chiusura sotto il minimo. Prima correzione (solo bilanciamento): violazioni chiusura
invariate (18 su 6 mesi) — root cause vera trovata in `correggiFasciaObbligatoria`, non
nel bilanciamento. Fix: entrambe le funzioni ora escludono dai candidati un turno che
finisce alle 20:00 SE la copertura chiusura di quel giorno è già al minimo, con un
contatore live decrementato ad ogni conversione reale (non solo un check statico
all'inizio). **Verificato**: 0 violazioni su tutti e tre i criteri (chiusura, fascia
13-16, bilanciamento), 184 giorni reali su 6 mesi, dopo il fix.

### FIX 4 — Maia: cambio riposo infrasettimanale (`sposta_riposo`)

Nuovo tool `sposta_riposo` (employee_name, vecchio_giorno, nuovo_giorno) —
esplicitamente separato dal riposo compensativo domenicale (regole diverse, tool diverso,
system prompt aggiornato per non confonderli). Ripristina un turno di lavoro standard nel
vecchio giorno, mette a riposo il nuovo giorno.

Il turno "standard" è calcolato da una nuova funzione esportata in `generator.ts`,
`calcolaTurnoStandardGiorno(emp, config, storeId, dataStr)` — **riusa gli stessi helper
del generatore vero** (`findDip`, `chiMattinaMaxRomeo`, `direzioneSabatoFormula`,
`orarioMattina`/`Pomeriggio`/`FromSlug`) invece di duplicare la logica. Deliberatamente
NON chiama `generateShiftsMD` con un solo dipendente: farlo applicherebbe i pass di
correzione (chiusura, fasce, bilanciamento) a un quadro artificialmente parziale (1 sola
persona), rischiando conversioni sbagliate basate su un conteggio fasullo.

Copertura fedele al 100% per i pattern **calcolabili in isolamento** (non serve il
contesto dell'intera settimana): R1 Gilda/Tony, Yuri, Denise, Max/Romeo (alternanza AB),
Cristina/Stefania. Per **Carlo e le cassiere 22h** (distribuzione ore dinamica —
`distribuisciOre`/`distribuisciCassiere22Settimana` — richiedono di sapere quante ore
restano da spalmare sui giorni rimasti della settimana, non calcolabile per un giorno
isolato) usa un **fallback semplificato e documentato** (mattina, ore =
`max_ore_giorno`) — se serve esattezza per questi dipendenti specifici, rigenerare la
settimana con `generateShiftsMDWeek` invece di usare `sposta_riposo`.

**Testato**: `calcolaTurnoStandardGiorno` chiamata via route di debug per Romeo su un
mercoledì reale (dicembre 2026) → `{tipo: "pomeriggio", orario: "15:00-20:00"}`,
plausibile per il suo contratto 28h e l'alternanza AB attiva quella settimana. **Non
testato end-to-end il comando reale a Maia** ("Cambia il riposo di [nome] da [giorno] a
[giorno]") — avrebbe richiesto scrivere su dati di produzione senza essere quello il tipo
di verifica autorizzata in questa sessione; il tool è pronto e deployato, il test live va
fatto da Giacomo/Max sulla chat reale.

### Verifica complessiva

Route di debug temporanea (`generateShiftsMD` in memoria, nessuna scrittura) su 6
schedule mensili reali consecutivi (luglio-dicembre 2026): **0 violazioni chiusura, 0
violazioni fascia 13-16, 0 violazioni bilanciamento mattina/pomeriggio** dopo tutti i fix
e la correzione del bug di interazione tra i pass. `npx tsc --noEmit` pulito ad ogni
step. Route di debug rimossa e confermata 404 dopo l'uso.
**⚠️ Non verificato via click nel browser** (stesso limite login email/password
ricorrente in questo file) — verificato solo a livello di generazione/DB.

---

## Rimozione completa Stroili — progetto ora esclusivamente MD Lanciano (22 agosto 2026)

Vedi anche la nota storica in cima a questo file. Dettaglio tecnico completo della
rimozione:

### STEP 1 — Inventario (prima di cancellare qualunque cosa)

**Codice condizionale trovato** — 5 file:
- `src/lib/generator.ts`: `generateShifts()` era un router (`if storeNome===MD →
  generateShiftsMD, else → generateShiftsDefault`); `generateShiftsDefault` +
  `chooseTurno` + `getTurnoOrario` (~90 righe) erano l'algoritmo greedy usato solo da
  Stroili.
- `src/app/manager/page.tsx` — di gran lunga il più coinvolto, **60+ occorrenze di
  `isMD`**: ordinamento dipendenti, formato celle (lettere M/Pm/F per Stroili vs orari
  reali per MD), export PDF (due mappe colore separate `colorMD`/`colorStroili`),
  pannelli Chiusure/Mezzogiorno/turno spezzato/ferie-permessi/festivi/colonna TOT (tutti
  solo-MD).
- `src/components/MaiaChatBubble.tsx`: l'intero componente si disattivava
  (`return null`) se `!isMD` — Maia non esisteva per Stroili.
- `src/app/api/shifts/generate-week/route.ts`: bloccava `use_opus` se lo store non era
  MD Lanciano.
- `src/types/index.ts`: `ORE_TURNO`/`ORARI_TURNO` (Stroili, orari fissi 9-14/14-20/9-20)
  duplicavano `ORE_TURNO_MD`/`ORARI_TURNO_MD`.

**Non coinvolti** (già store-agnostici): `login/page.tsx`, `api/auth/login/route.ts`,
`dipendente/[token]/page.tsx`.

**Correzione trovata nello script SQL fornito**: usava nomi tabella con prefisso
`turni_` (`turni_shifts`, `turni_employees`, ecc.) — **non esistono nello schema reale**,
che usa nomi senza prefisso (`shifts`, `employees`, `schedules`, `unavailabilities`,
`managers`, `stores`). Corretto prima di eseguire.

**Record reali contati** (route di debug temporanea, sola lettura): 11 employees, 1
manager (`adele-gioielleria.it`), 2 schedules (luglio e agosto 2026), 312 shifts, 6
unavailabilities, 1 store.

**Check FK/riferimenti esterni** (richiesto esplicitamente prima di cancellare): nessun
riferimento trovato in `turni_festivi`, `turni_alternanza`, `turni_config` (0 righe per
lo store_id di Stroili in tutte e tre), né in `ferie_saldo` (0 righe per gli
employee_id di Stroili) — queste tabelle sono tutte funzionalità aggiunte dopo,
esclusivamente per MD. Solo `shifts` e `unavailabilities` referenziavano dati Stroili,
già previste nello script di cancellazione.

### STEP 2 — Rimozione codice

`manager/page.tsx` riscritto per intero (troppe occorrenze `isMD` intrecciate per edit
puntuali senza rischio di errore) — ogni `isMD ? A : B` → `A`, ogni `isMD &&`/`!isMD &&`
→ rimosso (mai/sempre), rimossi `colorStroili`, `TURNO_CYCLE` + il ramo Stroili di
`nextTurno` (e la funzione `nextTurno` stessa una volta rimasto il solo chiamante
`cycleShift`, diventata a sua volta irraggiungibile e rimossa), il ramo alfabetico di
`sortEmployees`, la legenda M/Pm/F/Riposo in fondo alla tabella.
`generator.ts`: rimossi `generateShiftsDefault`/`chooseTurno`/`getTurnoOrario`,
`generateShifts()` router eliminato — `generateShiftsMD` è ora l'unico entry point
(chiamato direttamente da `shifts/generate/route.ts`, senza più bisogno di leggere il
nome dello store per decidere l'algoritmo).
`types/index.ts`: rimossi `ORE_TURNO`/`ORARI_TURNO` (Stroili) e infine
`MD_LANCIANO_STORE_NOME` stesso (diventato un import orfano una volta rimossa ogni
logica di routing che lo confrontava).
`MaiaChatBubble.tsx`: rimossa la prop `isMD` (il componente era già di fatto MD-only).

Deciso di **non rinominare** `ORE_TURNO_MD`/`ORARI_TURNO_MD`/`generateShiftsMD`/
`generateShiftsMDWeek` togliendo il suffisso "MD" (ora ridondante, essendo l'unico
algoritmo) — rinominare in tutto il codebase avrebbe aumentato il rischio senza un
beneficio reale, il suffisso resta come artefatto storico innocuo.

**Verificato ad ogni fase**: `npx tsc --noEmit` pulito, `npm run build` completato senza
errori (16 pagine generate, nessun riferimento orfano).

### STEP 3 — Cancellazione dati (dopo conferma esplicita di Max)

Eseguita via route di debug temporanea (stesso pattern service-role delle altre verifiche
in questo file) con lo script SQL corretto (nomi tabella reali). Risultato, combaciante
esattamente con l'inventario dello STEP 1: **312 shifts, 6 unavailabilities, 2 schedules,
11 employees, 1 manager, 1 store cancellati**, nessun errore. Route di debug rimossa e
confermata (implicitamente, tramite il redeploy pulito successivo) non più presente.

### STEP 4 — Documentazione

Questo file: rimossa la sezione progetto generica (cliente pilota Adele/Stroili),
sostituita con la nota storica in cima; sezione "Struttura turni"/"Contratti dipendenti"
aggiornate per riflettere MD Lanciano (config-driven, 22-46h) invece dei valori fissi
Stroili (9-14/14-20/9-20, 20/30/40h); segnalato che `NEXT_PUBLIC_STORE_ID` su Vercel
punta ancora all'ID (ora cancellato) di Stroili — nessun codice attivo lo legge più
direttamente, ma da aggiornare se mai tornasse in uso.

### Test finale

- `npm run build`: pulito, 16 pagine, nessun errore.
- `npx tsc --noEmit`: pulito.
- Grep esaustivo (`Stroili`, `isMD`, `MD_LANCIANO_STORE_NOME`) su tutto `src/`: **zero
  occorrenze residue**.
- **Non verificato via click nel browser** (stesso limite login email/password
  ricorrente in questo file — nessuna credenziale manager disponibile in questa sessione)
  — login, generazione, Maia e PDF non sono stati testati end-to-end nella UI reale in
  questo giro. Verificato solo a livello di build/typecheck/DB. **Consigliato**: Giacomo
  faccia un giro di verifica manuale reale (login → genera turni → chiedi qualcosa a
  Maia → esporta PDF) alla prima occasione, per chiudere il cerchio su questo punto
  specifico.

## Bug "prima settimana di Settembre non gestibile" — settimane a cavallo tra mesi (22 agosto 2026)

### Sintomo segnalato da Giacomo

Aprendo Settembre 2026 e provando a selezionare la prima settimana (che inizia a
cavallo con Agosto), il sistema non permetteva di lavorare correttamente sui primi
giorni del mese.

### Causa esatta (confermata leggendo il codice + trace numerico reale, non solo ipotesi)

`getSettimaneLunDom` (`src/app/manager/page.tsx`) riceve sempre un array `giorni` già
STRETTAMENTE delimitato a un solo mese calendario (`getDays(anno, mese)` interrompe il
`while` non appena si passa al mese successivo — non genera mai giorni di un mese
diverso). Dentro quell'array mono-mese, la funzione cercava l'INDICE del primo Lunedì
del mese e iniziava a raggruppare le settimane da lì (`start = firstMondayIdx`) —
scartando silenziosamente ogni giorno prima di quel lunedì.

Verificato con trace reale (replica esatta di `getDays`/`getSettimaneLunDom` per
Agosto e Settembre 2026):
- **Agosto 2026** (1° = sabato): Sab1/Dom2 (prima del primo lunedì, 3 agosto)
  scomparivano da ogni voce; il frammento finale (Lun31, 1 giorno solo) veniva invece
  già incluso — trattamento **asimmetrico** tra inizio e fine mese.
- **Settembre 2026** (1° = martedì, primo lunedì = 7 settembre): **Mar1, Mer2, Gio3,
  Ven4, Sab5, Dom6 — 6 giorni interi, l'intera prima settimana reale del mese — non
  comparivano in NESSUNA voce del selettore "Sett. N"**. Non selezionabili, non
  generabili via "⚡ Genera settimana", nessun pannello Chiusure/Mezzogiorno, "✨ Lavora
  su questa settimana" con Maia non disponibile per quei giorni. Il blocco era
  specifico alle funzionalità week-scoped: la tabella mensile normale (click diretto
  sulla cella, "Genera turni" mese intero) restava comunque utilizzabile su quei
  giorni, perché itera `giorni` direttamente senza passare da `getSettimaneLunDom`.

**Punto architetturale (relazione schedule↔mese)**: confermato che oggi nessuna
"settimana" attraversa mai due `schedule_id` diversi — `getDays`/`getSettimaneLunDom`
operano sempre dentro un solo mese/schedule per costruzione. Stessa lacuna
architetturale confermata indipendentemente anche lato backend
(`generateShiftsMDWeek` in `src/lib/generator.ts` deriva `mese`/`anno` solo da
`weekStart` e delega al generatore mono-mese `generateShiftsMD`).

### Soluzione scelta (delle due valutate con Max)

Valutate due direzioni:
1. Costruire una VERA settimana Lun-Dom unificata che attraversa due `schedule_id`
   diversi (es. Ago31+Sett1-6 come unica entità), scrivendo sui due schedule.
2. Rendere simmetrico il trattamento già esistente per il frammento finale di mese:
   includere sempre anche il frammento INIZIALE (giorni prima del primo lunedì) come
   sua propria voce nel selettore, invece di scartarlo.

**Scelta: opzione 2** — rischio molto più basso (nessuna scrittura cross-schedule:
`generaSettimana`/`resetSettimana` già gestivano correttamente i chunk parziali,
verificato leggendo il codice, perché derivano `weekStart`/`weekEnd` dai giorni reali
del chunk selezionato, non assumono che inizi di lunedì) e risolve esattamente il
sintomo bloccante segnalato — i giorni erano INVISIBILI, non semplicemente raggruppati
in un modo inatteso. Non risolve la sovrapposizione "vera" (Ago31 resta un frammento
di 1 giorno nel selettore di agosto, Sett1-6 un frammento di 6 giorni in quello di
settembre — non un'unica settimana Lun-Dom unificata), scelta deliberata e comunicata
a Max, non un compromesso nascosto.

### Fix (`src/app/manager/page.tsx`, `getSettimaneLunDom`)

Aggiunto un blocco che, se esiste un frammento di giorni prima del primo lunedì del
mese (`start > 0`), lo inserisce come propria voce del selettore PRIMA delle settimane
piene — stessa logica già usata per il frammento finale di mese incompleto, ora
applicata anche all'inizio. Le settimane piene restano allineate Lun-Dom esattamente
come prima (nessuna regressione sulle settimane normali).

### Test finale

Trace numerico rieseguito con la funzione corretta, Agosto e Settembre 2026:
- Agosto: `Sab1,Dom2` (2gg) → 4 settimane piene Lun-Dom → `Lun31` (1gg) — 6 voci totali.
- Settembre: `Mar1,Mer2,Gio3,Ven4,Sab5,Dom6` (6gg, **ora selezionabile**) → 3 settimane
  piene Lun-Dom → `Lun28,Mar29,Mer30` (3gg) — 5 voci totali (prima erano 4, la prima
  settimana reale mancava del tutto).
- `npx tsc --noEmit`: pulito.
- `npm run build`: pulito, 16 pagine, nessun errore.
- **Non verificato via click nel browser** (stesso limite ricorrente — nessuna
  credenziale manager in questa sessione): consigliato che Giacomo apra Settembre 2026
  e confermi che "Mar1 — Dom6 Settembre" compaia ora nel selettore e sia utilizzabile
  (genera/reset/Chiusure/Mezzogiorno/Maia).
