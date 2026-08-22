import {
  Employee, Shift, Unavailability, TurnoTipo,
} from '@/types'
import { supabaseAdmin } from './supabase'

interface GenerateParams {
  scheduleId: string
  employees: Employee[]
  unavailabilities: Unavailability[]
  mese: number
  anno: number
}

// ─────────────────────────────────────────────────────────────────────────────
// ALGORITMO MD LANCIANO — v2, config-driven da `turni_config` (Supabase)
// ─────────────────────────────────────────────────────────────────────────────
//
// Fonte di verità: la tabella `turni_config` (colonna `config`, JSONB) per lo
// store MD Lanciano. Il generatore la carica UNA VOLTA all'inizio di ogni
// chiamata a generateShiftsMD/generateShiftsMDWeek (non ad ogni assegnazione),
// e usa "pattern_standard" come default, "flessibilita" come margine di
// aggiustamento, "regola_assoluta" come vincolo mai violabile — stesso
// contratto di lettura che usa Maia (src/app/api/maia-chat/route.ts).
//
// DOMENICA: non gestita da questo algoritmo — sempre "riposo" di default,
// i turni domenicali vengono assegnati SOLO manualmente da Giacomo.
//
// SEMPLIFICAZIONI DOCUMENTATE (invariato rispetto a v1, salvo dove indicato):
// - La fascia obbligatoria cassa 13-16 (Yuri + min. 2 cassieri) viene ora
//   VERIFICATA dopo la generazione (console.warn se scoperta), ma non
//   corretta algoritmicamente — servirebbe un vero constraint solver.
//   Questo è uno dei motivi per cui STEP 3 introduce Claude Opus.
// - L'orario di inizio mattina flessibile (08/09/10/11) per le cassiere 22h
//   ruota deterministicamente per varietà, non è ottimizzato per copertura
//   reale — anche questo è terreno per Opus.
// - Le alternanze sabato di Cristina e Carlo (vedi sotto) non hanno una
//   tabella dedicata come `turni_alternanza` (Max/Romeo) — usano un'ancora
//   fissa nel codice, da confermare con Giacomo.

async function loadTurniConfig(storeId: string): Promise<any> {
  const { data, error } = await supabaseAdmin
    .from('turni_config')
    .select('config')
    .eq('store_id', storeId)
    .maybeSingle()
  if (error || !data?.config) {
    throw new Error(`turni_config mancante o non leggibile per store ${storeId} — impossibile generare turni MD Lanciano senza configurazione (${error?.message ?? 'nessuna riga trovata'})`)
  }
  return data.config
}

/** Giorni festivi italiani (turni_festivi) per lo store — trattati come domenica:
 * negozio chiuso, nessun turno, esclusi dal budget ore. Ritorna un Set di date
 * YYYY-MM-DD per lookup rapido nel loop giorni. */
async function loadFestivi(storeId: string): Promise<Set<string>> {
  const { data } = await supabaseAdmin
    .from('turni_festivi')
    .select('data')
    .eq('store_id', storeId)
  return new Set((data ?? []).map((f: any) => f.data))
}

function findDip(config: any, nome: string): any {
  const target = nome.trim().toLowerCase()
  return (config?.dipendenti ?? []).find((d: any) => (d.nome ?? '').trim().toLowerCase() === target) ?? null
}

/** Converte uno slug della legenda_orari ("08/16") in {inizio,fine} HH:MM. Tutti gli
 * slot della legenda sono in punto (nessun caso :30), quindi il parsing è semplice. */
function orarioFromSlug(slug: string): { inizio: string; fine: string } {
  const [a, b] = slug.split('/')
  return { inizio: `${a.padStart(2, '0')}:00`, fine: `${b.padStart(2, '0')}:00` }
}

// Legacy — usato da src/app/api/maia-chat/route.ts (Step 4: nessuna modifica lì).
// Ore fisse per giorno feriale per il contratto 28h (Cristina/Stefania), Lun-Ven.
// getDay(): 1=Lun...5=Ven. Sabato (6h) è il giorno di aggiustamento, gestito a parte.
export const ORE_28H_FERIALI: Record<number, number> = { 1: 5, 2: 4, 3: 5, 4: 4, 5: 4 }

function getMaxOreGiorno(dip: any, fallback = 6): number {
  return typeof dip?.max_ore_giorno === 'number' ? dip.max_ore_giorno : fallback
}

const MIN_ORE_PER_CONTRATTO: Record<number, number> = { 22: 3, 28: 4, 30: 4, 35: 5, 36: 6, 40: 6 }

/** R8 — Sconto ore per giorno festivo (feriale o sabato), tabella fissa per contratto
 * (confermata da Max, 6 agosto 2026). Sostituisce la vecchia logica "ridistribuzione a
 * budget pieno" (distribuisciOreConFestivi, rimossa): il target settimanale ora si
 * RIDUCE di questo valore fisso per ogni festivo nella settimana, indipendentemente da
 * quante ore varrebbe normalmente quel giorno specifico per quel dipendente — es. il
 * sabato di Ferragosto per le 22h scala comunque solo 3h, non le 5h che varrebbe
 * normalmente quel sabato. Applicata da applicaScontoFestivi() dopo la generazione. */
const SCONTO_FESTIVO_PER_CONTRATTO: Record<number, number> = { 22: 3, 28: 4, 30: 5, 35: 5, 36: 6, 40: 6 }

/** Distribuisce ore intere su N giorni, rispettando min/max giornaliero. */
function distribuisciOre(oreRimanenti: number, giorni: number, min: number, max: number): number[] {
  const result: number[] = []
  let rimanenti = oreRimanenti
  for (let i = giorni; i > 0; i--) {
    if (rimanenti <= 0) { result.push(0); continue }
    const oreGiorno = Math.min(max, Math.max(min, Math.ceil(rimanenti / i)))
    result.push(oreGiorno)
    rimanenti -= oreGiorno
  }
  return result
}

/** Orario mattina: inizio parametrizzabile (default 08:00 per compatibilità), fine = inizio + ore. */
function orarioMattina(ore: number, inizioOra: number = 8): { inizio: string; fine: string } {
  return { inizio: formatOra(inizioOra), fine: formatOra(inizioOra + ore) }
}

/** Orario mattina cassiere 22h: fine fissa 13:00, inizio flessibile = 13:00 - ore. */
function orarioMattinaFlessibile(ore: number): { inizio: string; fine: string } {
  return { inizio: formatOra(13 - ore), fine: '13:00' }
}

/** Orario pomeriggio: fine sempre 20:00 (chiusura negozio), inizio = 20:00 - ore. */
function orarioPomeriggio(ore: number): { inizio: string; fine: string } {
  return { inizio: formatOra(20 - ore), fine: '20:00' }
}

function formatOra(h: number): string {
  return `${String(Math.floor(h)).padStart(2, '0')}:00`
}

/** Ore lavorate calcolate dagli orari effettivi (non da un lookup fisso per tipo). */
export function oreFromOrario(inizio?: string | null, fine?: string | null): number {
  if (!inizio || !fine) return 0
  const [hi, mi] = inizio.split(':').map(Number)
  const [hf, mf] = fine.split(':').map(Number)
  return (hf * 60 + mf - (hi * 60 + mi)) / 60
}

/** Permesso a ore (assenza parziale): accorcia il turno togliendo `oreParziali` dall'inizio
 * (il dipendente entra più tardi, esce alla stessa ora) — es. 08/13 (5h) - 2h → 10/13 (3h).
 * Ritorna null se non c'è nulla da ridurre (turno assente/invalido, o le ore richieste
 * coprono l'intero turno o più — in quel caso è un permesso a giornata intera, non parziale). */
export function calcolaTurnoRidotto(
  oraInizio?: string | null,
  oraFine?: string | null,
  oreParziali?: number | null
): { ora_inizio: string; ora_fine: string } | null {
  if (!oraInizio || !oraFine || !oreParziali || oreParziali <= 0) return null
  const oreTotali = oreFromOrario(oraInizio, oraFine)
  if (oreParziali >= oreTotali) return null
  const [h, m] = oraInizio.split(':').map(Number)
  const nuovaOraInizio = `${String(h + oreParziali).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  return { ora_inizio: nuovaOraInizio, ora_fine: oraFine }
}

// ── Alternanza Max/Romeo — STESSO meccanismo di src/app/api/maia-chat/route.ts
// (funzione chiMattina), letto dalla tabella `turni_alternanza`: garantisce che
// generatore e Maia calcolino sempre la stessa risposta per la stessa settimana,
// invece di usare parità/imparità della settimana ISO scollegata da un riferimento.
function altroNomeAB(nome: string): string {
  return nome === 'Romeo' ? 'Max' : 'Romeo'
}

function getWeekIndex(dateStr: string): number {
  const d = new Date(dateStr + 'T00:00:00')
  const startOfYear = new Date(d.getFullYear(), 0, 1)
  return Math.floor((d.getTime() - startOfYear.getTime()) / (7 * 24 * 60 * 60 * 1000))
}

/** Lunedì della settimana contenente `data` (YYYY-MM-DD). */
function getMonday(dataStr: string): string {
  const d = new Date(dataStr + 'T00:00:00')
  const day = d.getDay() || 7 // domenica=7
  if (day !== 1) d.setDate(d.getDate() - (day - 1))
  return formatDate(d)
}

async function chiMattinaMaxRomeo(storeId: string, dataSettimana: string): Promise<{ mattina: string; pomeriggio: string }> {
  const { data: rif } = await supabaseAdmin
    .from('turni_alternanza')
    .select('*')
    .eq('store_id', storeId)
    .order('settimana_riferimento', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!rif) return { mattina: 'Romeo', pomeriggio: 'Max' }

  const settRif = getWeekIndex(rif.settimana_riferimento)
  const settCorrente = getWeekIndex(dataSettimana)
  const diff = settCorrente - settRif

  const nomeMattina = diff % 2 === 0 ? rif.nome_mattina : altroNomeAB(rif.nome_mattina)
  return { mattina: nomeMattina, pomeriggio: altroNomeAB(nomeMattina) }
}

// ── Alternanza sabato "no ripetizione" — Cristina e Carlo (Denise: vedi nota sotto).
// ⚠️ ASSUNZIONE DA CONFERMARE CON GIACOMO: a differenza di Max/Romeo, non esiste una
// tabella dedicata per queste alternanze — uso un'ancora fissa hardcoded qui, con una
// direzione di partenza scelta arbitrariamente. Se la direzione reale del sabato
// 2026-08-08 è diversa da quella indicata, invertire il valore corrispondente sotto.
const SABATO_ANCORA = '2026-08-08' // sabato della settimana di riferimento (2026-08-03)
const SABATO_ANCORA_DIREZIONE: Record<string, 'mattina' | 'pomeriggio'> = {
  Cristina: 'mattina', // ⚠️ assunzione — Stefania è sempre l'opposto di Cristina
  Carlo: 'mattina',    // ⚠️ assunzione
  Denise: 'mattina',   // ⚠️ assunzione
}

function direzioneSabatoFormula(nome: string, dataSabato: string): 'mattina' | 'pomeriggio' {
  const settAncora = getWeekIndex(SABATO_ANCORA)
  const settCorrente = getWeekIndex(dataSabato)
  const diff = ((settCorrente - settAncora) % 2 + 2) % 2 // gestisce anche diff negativi
  const base = SABATO_ANCORA_DIREZIONE[nome] ?? 'mattina'
  if (diff === 0) return base
  return base === 'mattina' ? 'pomeriggio' : 'mattina'
}

// ── Cassiere 22h — 3 mattina + 3 pomeriggio a settimana (sabato incluso), 5 agosto 2026 ──
// Regola confermata con Giacomo, sostituisce il vecchio PATTERN_COPPIE_22H (ciclo fisso
// a 3 giorni, prevedibile e scollegato dai confini di settimana):
// 1. Sabato: si inverte SEMPRE rispetto al sabato della settimana precedente per ogni
//    cassiera (letto dal DB — stessa data, qualsiasi mese/schedule appartenga).
// 2. Lun-Ven: liberi, nessun vincolo di ripetizione con la settimana precedente — solo il
//    totale 3 mattina + 3 pomeriggio a settimana (Sab incluso) e il 2+2 giornaliero.
// 3. Le coppie (chi è mattina insieme) variano da sola conseguenza della randomizzazione
//    controllata nella distribuzione Lun-Ven (shuffle ad ogni generazione) — nessuno
//    storico delle coppie tracciato esplicitamente, la variabilità è strutturale.
//
// Il sabato garantisce automaticamente 2+2 per induzione: se la settimana N ha esattamente
// 2 cassiere in mattina il sabato, la settimana N+1 le inverte tutte — quindi le 2 che
// erano mattina diventano pomeriggio e viceversa, restando sempre 2+2. Il seed sotto è
// la settimana "zero" (nessun sabato precedente in DB) con 2+2 di partenza.
const SEED_SABATO_22H: Record<string, 'mattina' | 'pomeriggio'> = {
  Angelica: 'mattina', Damiana: 'mattina', Elisa: 'pomeriggio', Marilena: 'pomeriggio',
}

/** Turno dell'ultimo sabato registrato per questo dipendente, indipendentemente dal
 * mese/schedule di appartenenza (la data è una chiave di calendario globale) — null se
 * non c'è nessun turno salvato quel giorno (prima settimana, o giorno non ancora generato). */
async function getSabatoPrecedente(empId: string, monday: string): Promise<'mattina' | 'pomeriggio' | null> {
  const sabatoPrec = new Date(monday + 'T00:00:00')
  sabatoPrec.setDate(sabatoPrec.getDate() - 2) // lunedì della settimana corrente - 2gg = sabato precedente
  try {
    const { data } = await supabaseAdmin
      .from('shifts')
      .select('tipo')
      .eq('employee_id', empId)
      .eq('data', formatDate(sabatoPrec))
      .maybeSingle()
    if (data?.tipo === 'mattina' || data?.tipo === 'pomeriggio') return data.tipo
    return null
  } catch (err) {
    console.error('getSabatoPrecedente error:', err)
    return null
  }
}

/** Distribuisce mattina/pomeriggio Lun-Ven per le cassiere 22h di una settimana, dato il
 * fabbisogno residuo di ciascuna (2 mattina se sabato=mattina, 3 se sabato=pomeriggio, e
 * viceversa per il pomeriggio) — garantendo sempre esattamente 2 mattina + 2 pomeriggio al
 * giorno. Forza le scelte quando il fabbisogno residuo coincide con i giorni rimasti
 * (altrimenti sforerebbe), sceglie a caso (shuffle) tra le libere per il resto — questa è
 * la "randomizzazione controllata" che fa variare le coppie nel tempo invece di un pattern
 * fisso e prevedibile. Ritorna, per ciascun nome, un array di 5 booleani (Lun..Ven, true
 * = mattina). */
function distribuisciCassiere22Settimana(
  nomi: string[],
  sabatoMattina: Record<string, boolean>
): Record<string, boolean[]> {
  const fabbisogno: Record<string, { mattina: number; pomeriggio: number }> = {}
  for (const nome of nomi) {
    fabbisogno[nome] = sabatoMattina[nome] ? { mattina: 2, pomeriggio: 3 } : { mattina: 3, pomeriggio: 2 }
  }

  const risultato: Record<string, boolean[]> = Object.fromEntries(nomi.map(n => [n, [] as boolean[]]))

  for (let giorno = 0; giorno < 5; giorno++) {
    const giorniRimastiInclusoOggi = 5 - giorno

    const forzatiMattina = nomi.filter(n => fabbisogno[n].mattina > 0 && fabbisogno[n].mattina === giorniRimastiInclusoOggi)
    const forzatiPomeriggio = nomi.filter(n => fabbisogno[n].mattina === 0)

    let mattinaOggi = forzatiMattina.slice(0, 2)
    let pomeriggioOggi = forzatiPomeriggio.slice(0, 2)
    if (forzatiMattina.length > 2 || forzatiPomeriggio.length > 2) {
      console.error('distribuisciCassiere22Settimana: stato inatteso (più di 2 forzati) — giorno', giorno, { forzatiMattina, forzatiPomeriggio })
    }

    const assegnati = new Set([...mattinaOggi, ...pomeriggioOggi])
    const liberi = nomi.filter(n => !assegnati.has(n))
    const shuffled = [...liberi].sort(() => Math.random() - 0.5)

    for (const n of shuffled) {
      if (mattinaOggi.length < 2) mattinaOggi.push(n)
      else pomeriggioOggi.push(n)
    }

    for (const n of mattinaOggi) { fabbisogno[n].mattina--; risultato[n].push(true) }
    for (const n of pomeriggioOggi) { fabbisogno[n].pomeriggio--; risultato[n].push(false) }
  }

  return risultato
}

// Orari di inizio mattina flessibili per le cassiere 22h (H — non più sempre 08:00).
// Rotazione deterministica per varietà; non ottimizzata per copertura reale (vedi nota Opus).
const MATTINA_FLEX_START = [8, 9, 10, 11]
function inizioMattinaFlessibile22h(nome: string, dataStr: string): number {
  const giorno = parseInt(dataStr.split('-')[2], 10)
  const idx = (giorno + nome.length) % MATTINA_FLEX_START.length
  return MATTINA_FLEX_START[idx]
}

// NOTE — semplificazioni rispetto alla specifica ideale (v2):
// - Denise: i 2 giorni da 8h sono fissati a Lunedì e Giovedì (spread nella settimana),
//   non calcolati dinamicamente in base a copertura reale (vedi nota Opus).
// - Direzione settimanale (non-sabato) Cristina/Stefania: Cristina fa Lun/Mer/Ven
//   mattina (dal suo pattern_standard in config), Stefania è sempre l'opposto —
//   la config non specifica esplicitamente CHI dei due fa quale direzione nei
//   giorni feriali, questa è un'interpretazione basata sul pattern_standard di
//   Cristina preso come riferimento.

export async function generateShiftsMD(params: GenerateParams): Promise<Omit<Shift, 'id' | 'created_at'>[]> {
  const { scheduleId, employees, unavailabilities, mese, anno } = params
  if (employees.length === 0) return []

  const storeId = employees[0].store_id
  const config = await loadTurniConfig(storeId)
  const festiviSet = await loadFestivi(storeId)

  const giorni = getDaysInMonth(anno, mese)
  const shifts: Omit<Shift, 'id' | 'created_at'>[] = []

  const unavailMap: Record<string, Set<string>> = {}
  for (const u of unavailabilities) {
    if (!unavailMap[u.employee_id]) unavailMap[u.employee_id] = new Set()
    unavailMap[u.employee_id].add(u.data)
  }

  // Cache alternanza Max/Romeo per settimana, ANCORATA AL LUNEDÌ (non al giorno corrente):
  // getWeekIndex ha il confine di settimana il giovedì (1/1/2026 è giovedì), lo stesso
  // meccanismo usato da chiMattina in maia-chat/route.ts — usarlo giorno per giorno farebbe
  // "flippare" Max/Romeo a metà settimana (visto durante il test del 2026-08-03/08).
  // Qui calcoliamo l'alternanza UNA VOLTA a settimana usando sempre il lunedì come
  // riferimento, cosa che chiMattina non fa quando interrogata da Maia su un giorno
  // diverso dal lunedì — possibile disallineamento residuo, da correggere in un giro
  // successivo su maia-chat/route.ts (fuori scope qui, vedi nota nel report).
  const alternanzaCache: Record<string, { mattina: string; pomeriggio: string }> = {}
  async function getAlternanzaSettimana(dataStr: string) {
    const monday = getMonday(dataStr)
    if (!(monday in alternanzaCache)) {
      alternanzaCache[monday] = await chiMattinaMaxRomeo(storeId, monday)
    }
    return alternanzaCache[monday]
  }

  // Piano ore Lun-Ven per dipendenti a distribuzione variabile (Carlo, cassiere 22h),
  // ricalcolato ogni volta che cambia settimana ISO. Non ha più awareness dei festivi
  // qui: la distribuzione avviene come se la settimana fosse sempre completa (5 slot),
  // esattamente come per ogni altro dipendente a pattern fisso — il giorno festivo
  // diventa comunque 'riposo' più sotto nel loop principale (quindi le ore
  // eventualmente pianificate su quel giorno vengono scartate). Lo sconto vero e
  // proprio (tabella fissa per contratto, non proporzionale al pattern del giorno)
  // viene applicato UNA VOLTA per tutti i dipendenti da applicaScontoFestivi() dopo
  // la generazione — vedi SCONTO_FESTIVO_PER_CONTRATTO. Sostituisce la vecchia
  // distribuisciOreConFestivi ("ridistribuzione a budget pieno", rimossa).
  const pianoSettimanale: Record<string, { settimana: number; oreGiorni: number[] }> = {}
  function getPianoGiorno(emp: Employee, dip: any, settimana: number, weekdayIdx: number, oreSettimanaliFeriali: number): number {
    const key = emp.id
    const max = getMaxOreGiorno(dip)
    const min = MIN_ORE_PER_CONTRATTO[emp.ore_settimanali] ?? 4
    let piano = pianoSettimanale[key]
    if (!piano || piano.settimana !== settimana) {
      piano = { settimana, oreGiorni: distribuisciOre(oreSettimanaliFeriali, 5, min, max) }
      pianoSettimanale[key] = piano
    }
    return piano.oreGiorni[weekdayIdx] ?? 0
  }

  // Cache settimanale cassiere 22h: direzione sabato (inversa della precedente) + la
  // distribuzione Lun-Ven risultante, calcolate UNA VOLTA a settimana (ancorata al
  // lunedì, stesso motivo dell'alternanza Max/Romeo sopra) e riusate per tutti i giorni
  // e tutte le cassiere di quella settimana.
  const cassiere22Cache: Record<string, { sat: Record<string, boolean>; lunVen: Record<string, boolean[]> }> = {}
  async function getCassiera22Settimana(dataStr: string) {
    const monday = getMonday(dataStr)
    if (cassiere22Cache[monday]) return cassiere22Cache[monday]

    const nomiCassiere22 = employees
      .map(e => e.nome.trim())
      .filter(nome => findDip(config, nome)?.alternanza?.gruppo === '22h')

    const empByNome = new Map(employees.map(e => [e.nome.trim(), e]))
    const sat: Record<string, boolean> = {}
    for (const nome of nomiCassiere22) {
      const emp = empByNome.get(nome)!
      const precedente = await getSabatoPrecedente(emp.id, monday)
      const direzione = precedente ? (precedente === 'mattina' ? 'pomeriggio' : 'mattina') : (SEED_SABATO_22H[nome] ?? 'mattina')
      sat[nome] = direzione === 'mattina'
    }

    const lunVen = distribuisciCassiere22Settimana(nomiCassiere22, sat)
    const risultato = { sat, lunVen }
    cassiere22Cache[monday] = risultato
    return risultato
  }

  for (const giorno of giorni) {
    const dataStr = formatDate(giorno)
    const dayOfWeek = giorno.getDay() // 0=domenica, 1=lunedì ... 6=sabato
    const settimana = getIsoWeek(giorno)
    const weekdayIdx = dayOfWeek - 1 // 0=Lun..4=Ven (Sabato=5 non usato qui)

    // ── Domenica o festivo: riposo per tutti — negozio chiuso, nessuna assegnazione.
    if (dayOfWeek === 0 || festiviSet.has(dataStr)) {
      for (const emp of employees) {
        shifts.push({ schedule_id: scheduleId, employee_id: emp.id, data: dataStr, tipo: 'riposo' })
      }
      continue
    }

    // ── Giorno feriale ────────────────────────────────────────────────────────
    for (const emp of employees) {
      const nome = emp.nome.trim()
      const dip = findDip(config, nome)

      // Indisponibilità dichiarata → riposo
      if (unavailMap[emp.id]?.has(dataStr)) {
        shifts.push({ schedule_id: scheduleId, employee_id: emp.id, data: dataStr, tipo: 'riposo' })
        continue
      }

      let tipo: TurnoTipo = 'riposo'
      let orario: { inizio: string; fine: string } | null = null

      if (!dip) {
        // Dipendente attivo ma assente da turni_config — riposo di sicurezza,
        // non inventiamo un pattern per qualcuno non configurato.
        console.warn(`[GENERATOR] ${nome} attivo ma assente da turni_config — assegnato riposo di sicurezza il ${dataStr}`)
        shifts.push({ schedule_id: scheduleId, employee_id: emp.id, data: dataStr, tipo: 'riposo' })
        continue
      }

      // R1 — Gilda/Tony: pattern fisso "lun_sab" — sempre mattina, mai domenica (già escluso sopra).
      if (dip.pattern_standard?.lun_sab) {
        const slot = dip.pattern_standard.lun_sab
        tipo = 'mattina'
        orario = orarioFromSlug(slot.orario)
      }

      // Yuri — pattern per-giorno esplicito in config, presenza fissa 13-16 tutti i giorni.
      else if (nome === 'Yuri') {
        const giornoKey = ['domenica', 'lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato'][dayOfWeek]
        const slot = dip.pattern_standard?.[giornoKey]
        if (slot && typeof slot === 'object') {
          tipo = slot.tipo as TurnoTipo
          orario = orarioFromSlug(slot.orario)
        } else {
          tipo = 'mattina'
          orario = orarioMattina(6)
        }
      }

      // Denise — 40h su 6 giorni: 2×8h (Lun/Gio) + 4×6h (Mar/Mer/Ven/Sab) = 40h esatte.
      else if (nome === 'Denise') {
        const ORE_DENISE: Record<number, number> = { 1: 8, 2: 6, 3: 6, 4: 8, 5: 6, 6: 6 }
        const ore = ORE_DENISE[dayOfWeek] ?? 6
        if (dayOfWeek === 6) {
          const direzione = direzioneSabatoFormula('Denise', dataStr)
          tipo = direzione
          orario = direzione === 'mattina' ? orarioMattina(ore) : orarioPomeriggio(ore)
        } else {
          // Alterna mattina/pomeriggio nei feriali per varietà (flessibilita: "turno libero").
          const mattinaGiorni = [1, 3, 5] // Lun/Mer/Ven mattina, Mar/Gio pomeriggio
          tipo = mattinaGiorni.includes(dayOfWeek) ? 'mattina' : 'pomeriggio'
          orario = tipo === 'mattina' ? orarioMattina(ore) : orarioPomeriggio(ore)
        }
      }

      // Max/Romeo — alternanza settimanale AB simmetrica, letta da turni_alternanza
      // (sync con Maia). Romeo alterna mattina/pomeriggio esattamente come Max — lo
      // scarico merce Lun/Mer/Ven non è più un vincolo fisso legato a Romeo, viene
      // gestito da chiunque sia in turno mattina quei giorni (nessuna logica dedicata
      // qui). Romeo mantiene però il proprio monte-ore giornaliero da contratto (28h,
      // distribuito 5/4/5/4/5 nei feriali + sabato di aggiustamento) — solo la
      // direzione mattina/pomeriggio segue l'alternanza, non gli orari esatti di Max.
      else if (dip.alternanza?.gruppo === 'AB') {
        const alternanza = await getAlternanzaSettimana(dataStr)
        const mattinaOra = alternanza.mattina === nome

        if (nome === 'Max') {
          const slot = mattinaOra ? dip.pattern_standard.mattina : dip.pattern_standard.pomeriggio
          tipo = mattinaOra ? 'mattina_corta' : 'pomeriggio_corto'
          orario = orarioFromSlug(slot.orario)
        } else {
          // Romeo: ore giornaliere dal proprio pattern_standard (invariate), direzione
          // (mattina/pomeriggio) dall'alternanza settimanale — stesso principio di Max.
          let ore: number
          if (dayOfWeek === 6) {
            // Sabato — aggiustamento finale: 28h - ore feriali fisse (23h) = 5h, con
            // flessibilità fino a max_ore_giorno (6h, B risolto: JSON ha ragione).
            const oreFeriali = 5 + 4 + 5 + 4 + 5
            ore = Math.min(getMaxOreGiorno(dip), Math.max(5, emp.ore_settimanali - oreFeriali))
          } else {
            const giornoKey = ['', 'lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi'][dayOfWeek]
            ore = dip.pattern_standard[giornoKey]?.ore ?? 4
          }
          tipo = mattinaOra ? 'mattina' : 'pomeriggio'
          orario = mattinaOra ? orarioMattina(ore) : orarioPomeriggio(ore)
        }
      }

      // Carlo — Mar/Gio mattina OBBLIGATORIO (regola_assoluta), altri giorni da distribuzione,
      // sabato alterna mattina/pomeriggio soggetto a sabato_no_ripetizione.
      else if (nome === 'Carlo') {
        if (dayOfWeek === 6) {
          const direzione = direzioneSabatoFormula('Carlo', dataStr)
          const ore = getMaxOreGiorno(dip)
          tipo = direzione
          orario = direzione === 'mattina' ? orarioMattina(ore) : orarioPomeriggio(ore)
        } else {
          const max = getMaxOreGiorno(dip)
          const min = MIN_ORE_PER_CONTRATTO[emp.ore_settimanali] ?? 4
          const oreSettimanaliFeriali = Math.max(0, emp.ore_settimanali - max) // sabato preso a parte
          const ore = getPianoGiorno(emp, dip, settimana, weekdayIdx, oreSettimanaliFeriali)
          if (dayOfWeek === 2 || dayOfWeek === 4) {
            // Obbligatorio mattina — usa comunque le ore della distribuzione, non extra.
            tipo = 'mattina'
            orario = orarioMattina(Math.max(min, ore))
          } else if (ore <= 0) {
            tipo = 'riposo'; orario = null
          } else {
            tipo = 'mattina' // preferenza mattina di default per gli altri feriali
            orario = orarioMattina(ore)
          }
        }
      }

      // Cristina/Stefania — sempre opposte (mai stesso turno stesso giorno, sabato incluso),
      // ore per giorno da ORE_28H_FERIALI (legacy, condiviso con Maia), sabato 6h fisse.
      else if (nome === 'Cristina' || nome === 'Stefania') {
        // Cristina è il riferimento: Lun/Mer/Ven mattina, Mar/Gio pomeriggio (dal suo
        // pattern_standard). Stefania è sempre l'opposto di Cristina, ogni giorno.
        const cristinaMattinaGiorni = [1, 3, 5]
        const cristinaEMattina = cristinaMattinaGiorni.includes(dayOfWeek)
        const eMattina = nome === 'Cristina' ? cristinaEMattina : !cristinaEMattina

        if (dayOfWeek === 6) {
          const direzioneCristina = direzioneSabatoFormula('Cristina', dataStr)
          const mia = nome === 'Cristina' ? direzioneCristina : (direzioneCristina === 'mattina' ? 'pomeriggio' : 'mattina')
          tipo = mia
          orario = mia === 'mattina' ? orarioMattina(6) : orarioPomeriggio(6)
        } else {
          const ore = ORE_28H_FERIALI[dayOfWeek] ?? 4
          tipo = eMattina ? 'mattina' : 'pomeriggio'
          orario = eMattina ? orarioMattina(ore) : orarioPomeriggio(ore)
        }
      }

      // Cassiere 22h — 3 mattina + 3 pomeriggio a settimana (sabato incluso), sabato
      // invertito rispetto al precedente, Lun-Ven variabile — ore da distribuzione,
      // inizio mattina flessibile 08/09/10/11 (H). Vedi getCassiera22Settimana sopra.
      else if (dip.alternanza?.gruppo === '22h') {
        const settimana22h = await getCassiera22Settimana(dataStr)
        const mattinaOra = dayOfWeek === 6 ? (settimana22h.sat[nome] ?? false) : (settimana22h.lunVen[nome]?.[weekdayIdx] ?? false)
        if (dayOfWeek === 6) {
          // Sabato: durata FISSA a 5h (il budget settimanale la assume fissa — vedi
          // oreSettimanaliFeriali sotto). L'inizio flessibile (H) si applica solo ai
          // feriali: usarlo qui end-anchorato a 13:00 accorcerebbe la durata invece di
          // spostare solo l'inizio (bug trovato in test — Damiana/Elisa sotto budget).
          tipo = mattinaOra ? 'mattina' : 'pomeriggio'
          orario = mattinaOra ? orarioMattinaFlessibile(5) : orarioPomeriggio(5)
        } else {
          const oreSettimanaliFeriali = Math.max(0, emp.ore_settimanali - 5) // sabato ~5h fisse
          const ore = getPianoGiorno(emp, dip, settimana, weekdayIdx, oreSettimanaliFeriali)
          if (ore <= 0) {
            tipo = 'riposo'; orario = null
          } else if (mattinaOra) {
            tipo = 'mattina'
            const inizioFlessibile = inizioMattinaFlessibile22h(nome, dataStr)
            orario = inizioFlessibile === 8
              ? orarioMattinaFlessibile(ore) // end-anchored a 13:00, coerente col caso base
              : { inizio: formatOra(inizioFlessibile), fine: formatOra(inizioFlessibile + ore) }
          } else {
            tipo = 'pomeriggio'
            orario = orarioPomeriggio(ore)
          }
        }
      }

      // Fallback — dipendente in config ma non coperto da nessun ramo sopra.
      else {
        const max = getMaxOreGiorno(dip)
        const min = MIN_ORE_PER_CONTRATTO[emp.ore_settimanali] ?? 4
        const oreDef = Math.round(emp.ore_settimanali / 6)
        if (dayOfWeek === 6) {
          tipo = 'mattina'
          orario = orarioMattina(Math.min(max, oreDef))
        } else {
          tipo = dayOfWeek % 2 === 0 ? 'mattina' : 'pomeriggio'
          const ore = Math.min(max, Math.max(min, oreDef))
          orario = tipo === 'mattina' ? orarioMattina(ore) : orarioPomeriggio(ore)
        }
      }

      shifts.push({
        schedule_id: scheduleId,
        employee_id: emp.id,
        data: dataStr,
        tipo,
        ora_inizio: orario?.inizio,
        ora_fine: orario?.fine,
      })
    }
  }

  correggiChiusura(shifts, employees, config, festiviSet)
  correggiFasciaCentrale(shifts, employees, config, festiviSet)
  correggiFasciaObbligatoria(shifts, employees, config, festiviSet)
  correggiBilanciamentoMattinaPomeriggio(shifts, employees, config, festiviSet)
  applicaScontoFestivi(shifts, employees, config, festiviSet)
  verificaBudgetSettimanale(shifts, employees, festiviSet)

  return shifts
}

/** R8 — Applica lo sconto ore festivo (SCONTO_FESTIVO_PER_CONTRATTO) a TUTTI i
 * dipendenti, indipendentemente da come vengono calcolate le loro ore giornaliere
 * (pattern fisso o distribuzione dinamica). Passata post-generazione (come
 * correggiChiusura): per ogni dipendente e settimana ISO con almeno un festivo
 * (feriale o sabato, la domenica è già esclusa dal budget), confronta il totale
 * ore effettivamente generato con l'atteso (ore_contratto - sconto×numero_festivi)
 * e corregge la differenza allungando o accorciando UN turno mattina/pomeriggio
 * "normale" di quella settimana — mai i turni a orario fisso vincolato da una
 * regola assoluta (Yuri 13-16 obbligatorio, Max Legge 104 mai oltre 5h/giorno:
 * questi hanno tipo yuri_full/yuri_pomeriggio/mattina_corta/pomeriggio_corto,
 * esclusi perché il filtro qui sotto accetta solo tipo 'mattina'/'pomeriggio').
 * Se nessun turno regolabile è trovato entro min/max contrattuale, logga un
 * warning invece di forzare (stesso principio di verificaFasciaObbligatoria). */
function applicaScontoFestivi(
  shifts: Omit<Shift, 'id' | 'created_at'>[],
  employees: Employee[],
  config: any,
  festiviSet: Set<string>
): void {
  const festiviPerSettimana: Record<number, number> = {}
  for (const dStr of Array.from(festiviSet)) {
    const d = new Date(dStr + 'T00:00:00')
    if (d.getDay() === 0) continue // domenica già esclusa dal budget, non conta come sconto aggiuntivo
    const settimana = getIsoWeek(d)
    festiviPerSettimana[settimana] = (festiviPerSettimana[settimana] ?? 0) + 1
  }
  if (Object.keys(festiviPerSettimana).length === 0) return

  const perEmpSettimana: Record<string, Record<number, Omit<Shift, 'id' | 'created_at'>[]>> = {}
  for (const s of shifts) {
    if (s.tipo === 'riposo' || s.tipo === 'domenica_lungo' || s.tipo === 'domenica_corto') continue
    const settimana = getIsoWeek(new Date(s.data + 'T00:00:00'))
    if (!festiviPerSettimana[settimana]) continue
    perEmpSettimana[s.employee_id] ??= {}
    perEmpSettimana[s.employee_id][settimana] ??= []
    perEmpSettimana[s.employee_id][settimana].push(s)
  }

  for (const emp of employees) {
    const sconto = SCONTO_FESTIVO_PER_CONTRATTO[emp.ore_settimanali]
    if (sconto == null) {
      console.warn(`[GENERATOR] ⚠️ ${emp.nome.trim()}: contratto ${emp.ore_settimanali}h assente da SCONTO_FESTIVO_PER_CONTRATTO — nessuno sconto festivo applicato, verificare tabella`)
      continue
    }
    const perSettimana = perEmpSettimana[emp.id]
    if (!perSettimana) continue

    for (const [settStr, empShifts] of Object.entries(perSettimana)) {
      const settimana = Number(settStr)
      const numFestivi = festiviPerSettimana[settimana]
      const scontoAtteso = sconto * numFestivi
      const oreAttese = emp.ore_settimanali - scontoAtteso
      const oreAttuali = empShifts.reduce((sum, s) => sum + oreFromOrario(s.ora_inizio, s.ora_fine), 0)
      let diff = oreAttuali - oreAttese // >0 → togliere ore, <0 → aggiungere ore
      if (diff === 0) continue

      const dip = findDip(config, emp.nome.trim())
      const isCassiera22 = dip?.alternanza?.gruppo === '22h'
      const min = MIN_ORE_PER_CONTRATTO[emp.ore_settimanali] ?? 3
      const max = getMaxOreGiorno(dip)

      const candidati = empShifts
        .filter(s => s.tipo === 'mattina' || s.tipo === 'pomeriggio')
        .sort((a, b) => oreFromOrario(b.ora_inizio, b.ora_fine) - oreFromOrario(a.ora_inizio, a.ora_fine))

      for (const s of candidati) {
        if (diff === 0) break
        const oreCorrenti = oreFromOrario(s.ora_inizio, s.ora_fine)
        const oreNuove = Math.min(max, Math.max(min, oreCorrenti - diff))
        const applicato = oreCorrenti - oreNuove
        if (applicato === 0) continue
        const isMattina = s.tipo === 'mattina'
        const nuovoOrario = isMattina
          ? (isCassiera22 ? orarioMattinaFlessibile(oreNuove) : orarioMattina(oreNuove))
          : orarioPomeriggio(oreNuove)
        s.ora_inizio = nuovoOrario.inizio
        s.ora_fine = nuovoOrario.fine
        diff -= applicato
      }

      if (diff !== 0) {
        console.warn(`[GENERATOR] ⚠️ Sconto festivo non applicabile per intero a ${emp.nome.trim()} settimana ISO ${settimana}: differenza residua ${diff}h (nessun turno regolabile entro min/max) — verificare manualmente`)
      }
    }
  }
}

/** Controllo di sicurezza (solo warning, non blocca): somma le ore settimanali
 * generate per ogni dipendente e segnala scostamenti dal target atteso. Aggiunto
 * dopo aver trovato un bug reale in test (sabato 22h con inizio flessibile che
 * accorciava la durata invece di spostare solo l'inizio — vedi fix in questo file).
 * Tiene conto dei festivi (R8): in una settimana con festivo il target atteso non
 * è più ore_contratto ma ore_contratto - sconto×numero_festivi, altrimenti questo
 * controllo darebbe un falso allarme ogni volta che applicaScontoFestivi ha
 * correttamente ridotto il totale. */
function verificaBudgetSettimanale(shifts: Omit<Shift, 'id' | 'created_at'>[], employees: Employee[], festiviSet: Set<string>): void {
  const festiviPerSettimana: Record<number, number> = {}
  for (const dStr of Array.from(festiviSet)) {
    const d = new Date(dStr + 'T00:00:00')
    if (d.getDay() === 0) continue
    const settimana = getIsoWeek(d)
    festiviPerSettimana[settimana] = (festiviPerSettimana[settimana] ?? 0) + 1
  }

  const perSettimanaPerDip: Record<string, Record<number, number>> = {}
  for (const s of shifts) {
    if (s.tipo === 'riposo' || s.tipo === 'domenica_lungo' || s.tipo === 'domenica_corto') continue
    const settimana = getIsoWeek(new Date(s.data + 'T00:00:00'))
    perSettimanaPerDip[s.employee_id] ??= {}
    perSettimanaPerDip[s.employee_id][settimana] = (perSettimanaPerDip[s.employee_id][settimana] ?? 0) + oreFromOrario(s.ora_inizio, s.ora_fine)
  }
  for (const [employeeId, perSettimana] of Object.entries(perSettimanaPerDip)) {
    const emp = employees.find(e => e.id === employeeId)
    if (!emp) continue
    for (const [settimana, ore] of Object.entries(perSettimana)) {
      const numFestivi = festiviPerSettimana[Number(settimana)] ?? 0
      const sconto = numFestivi > 0 ? (SCONTO_FESTIVO_PER_CONTRATTO[emp.ore_settimanali] ?? 0) * numFestivi : 0
      const atteso = emp.ore_settimanali - sconto
      if (ore !== atteso) {
        console.warn(`[GENERATOR] ⚠️ ${emp.nome.trim()} settimana ISO ${settimana}: ${ore}h generate invece di ${atteso}h atteso (contratto ${emp.ore_settimanali}h${numFestivi > 0 ? `, ${numFestivi} festivo/i` : ''}) — verificare manualmente`)
      }
    }
  }
}

interface GenerateWeekParams {
  scheduleId: string
  employees: Employee[]
  unavailabilities: Unavailability[]
  domenicaShifts: { employee_id: string; tipo: string }[] // turni domenicali già assegnati quella settimana
  weekStart: string // Lun YYYY-MM-DD
  weekEnd: string   // Sab YYYY-MM-DD
}

/** Genera i turni Lun-Sab di UNA settimana, rispettando le domeniche già assegnate.
 * Riusa generateShiftsMD (stessa identica logica del mese intero — nessuna duplicazione
 * delle regole per Romeo/cassiere22/Yuri/ecc.), filtra al range richiesto, poi applica
 * un pass di bilanciamento automatico per chi ha già lavorato domenica quella settimana:
 * stesse regole del bilanciamento interattivo di Maia (Romeo solo Lun/Mer/Ven, altri mai
 * Sab/Dom, mai sotto il minimo contrattuale) ma applicato subito, senza conferma. */
export async function generateShiftsMDWeek(params: GenerateWeekParams): Promise<Omit<Shift, 'id' | 'created_at'>[]> {
  const { scheduleId, employees, unavailabilities, domenicaShifts, weekStart, weekEnd } = params

  const startDate = new Date(weekStart + 'T00:00:00')
  const mese = startDate.getMonth() + 1
  const anno = startDate.getFullYear()

  const shiftsMese = await generateShiftsMD({
    scheduleId, employees, unavailabilities, mese, anno,
  })
  const shiftsSettimana = shiftsMese.filter(s => s.data >= weekStart && s.data <= weekEnd)

  const domenicaMap: Record<string, number> = {}
  for (const ds of domenicaShifts) {
    domenicaMap[ds.employee_id] = ds.tipo === 'domenica_lungo' ? 5 : 3
  }

  const storeId = employees[0]?.store_id
  const config = storeId ? await loadTurniConfig(storeId) : null

  for (const emp of employees) {
    const oreDomenica = domenicaMap[emp.id]
    if (!oreDomenica) continue

    const dip = config ? findDip(config, emp.nome.trim()) : null
    const empShifts = shiftsSettimana.filter(s => s.employee_id === emp.id && s.tipo !== 'riposo')
    const oreFeriali = empShifts.reduce((sum, s) => sum + oreFromOrario(s.ora_inizio, s.ora_fine), 0)
    const eccesso = (oreFeriali + oreDomenica) - emp.ore_settimanali
    if (eccesso <= 0) continue

    const isRomeo = emp.nome.trim() === 'Romeo'
    const isCassiera22 = dip?.alternanza?.gruppo === '22h'
    const minGiorno = MIN_ORE_PER_CONTRATTO[emp.ore_settimanali] ?? 3

    const candidati = empShifts
      .filter(s => {
        const dow = new Date(s.data + 'T00:00:00').getDay()
        if (dow === 6 || dow === 0) return false // mai sabato/domenica come recupero
        if (isRomeo) return dow === 1 || dow === 3 || dow === 5 // Romeo: SOLO Lun/Mer/Ven
        return true
      })
      .sort((a, b) => oreFromOrario(b.ora_inizio, b.ora_fine) - oreFromOrario(a.ora_inizio, a.ora_fine))

    for (const s of candidati) {
      const oreGiorno = oreFromOrario(s.ora_inizio, s.ora_fine)
      const isMattina = s.tipo === 'mattina' || s.tipo === 'mattina_corta'

      if (oreGiorno === eccesso) {
        s.tipo = 'riposo'
        s.ora_inizio = undefined
        s.ora_fine = undefined
        break
      }

      const oreNuove = oreGiorno - eccesso
      if (oreNuove >= minGiorno) {
        const nuovoOrario = isMattina
          ? (isCassiera22 ? orarioMattinaFlessibile(oreNuove) : orarioMattina(oreNuove))
          : orarioPomeriggio(oreNuove)
        s.tipo = isMattina ? 'mattina' : 'pomeriggio'
        s.ora_inizio = nuovoOrario.inizio
        s.ora_fine = nuovoOrario.fine
        break
      }
    }
  }

  return shiftsSettimana
}

/** R7 — Chiusura 20:00: copertura minima da config (regole_generali.copertura_chiusura).
 * Pass di correzione post-generazione: se un giorno non raggiunge la copertura minima,
 * converte turni mattina di cassiere (esclusi non_cassiere, chi ha flessibilita "Nessuna",
 * e Yuri per la fascia obbligatoria) in pomeriggio a parità di ore già assegnate.
 *
 * 🐛 21/08/2026 (segnalato da Giacomo — "a volte solo 2 persone invece di 3"):
 * VERIFICATO su 6 mesi di dati reali (luglio-dicembre 2026) — ZERO casi di
 * sotto-copertura generati da questa funzione (festivi esclusi correttamente
 * dal check). Test sintetico con assenze crescenti: serve che 8 dipendenti su
 * 13 siano assenti LO STESSO giorno prima che il pool di candidati si esaurisca
 * — scenario irrealistico per ferie/assenze normali. Non è quindi il bug reale
 * più probabile (l'ipotesi "pool eroso dalle ferie" non regge sotto test).
 * Sospetto più concreto, non risolto qui (fuori scope — servirebbe toccare
 * maia-chat/route.ts): modifiche manuali post-generazione (update_shift via
 * Maia, o click diretto in manager/page.tsx) NON ri-eseguono questo pass — se
 * Giacomo sposta un turno dopo aver generato, la copertura di quel giorno può
 * rompersi senza che nessuna verifica lo segnali.
 * Fix applicato qui: la funzione non loggava MAI un warning quando falliva a
 * raggiungere il minimo (a differenza di correggiFasciaCentrale, che lo fa) —
 * fallimento silenzioso confermato e corretto, indipendentemente dalla causa
 * reale della segnalazione. Aggiunta anche l'esclusione domenica/festivi dal
 * check (mancava — senza festiviSet, ogni domenica/festivo con tutti a riposo
 * avrebbe generato un falso warning "chiusura scoperta"). */
function correggiChiusura(shifts: Omit<Shift, 'id' | 'created_at'>[], employees: Employee[], config: any, festiviSet: Set<string>): void {
  const perGiorno: Record<string, Omit<Shift, 'id' | 'created_at'>[]> = {}
  for (const s of shifts) {
    if (!perGiorno[s.data]) perGiorno[s.data] = []
    perGiorno[s.data].push(s)
  }

  const cop = config?.regole_generali?.copertura_chiusura ?? { lun_ven: 3, sabato: 4 }

  for (const [data, dayShifts] of Object.entries(perGiorno)) {
    const dow = new Date(data + 'T00:00:00').getDay()
    if (dow === 0 || festiviSet.has(data)) continue // negozio chiuso, nessuna copertura attesa

    const isSabato = dow === 6
    const minRichiesto = isSabato ? cop.sabato : cop.lun_ven
    let chiusura = dayShifts.filter(s => s.ora_fine === '20:00').length
    if (chiusura >= minRichiesto) continue

    const candidati = dayShifts
      .filter(s => {
        const emp = employees.find(e => e.id === s.employee_id)
        if (!emp) return false
        const nome = emp.nome.trim()
        const dip = findDip(config, nome)
        const esclusoStrutturale = dip?.ruolo === 'non_cassiere'
          || (dip?.flessibilita ?? '').toLowerCase().includes('nessuna')
          || nome === 'Yuri' // presenza fissa 13-16, mai spostare
        if (esclusoStrutturale) return false
        return s.tipo === 'mattina' && s.ora_fine !== '20:00'
      })
      .sort((a, b) => oreFromOrario(b.ora_inizio, b.ora_fine) - oreFromOrario(a.ora_inizio, a.ora_fine))

    for (const s of candidati) {
      if (chiusura >= minRichiesto) break
      const ore = oreFromOrario(s.ora_inizio, s.ora_fine)
      const nuovoOrario = orarioPomeriggio(ore)
      s.tipo = 'pomeriggio'
      s.ora_inizio = nuovoOrario.inizio
      s.ora_fine = nuovoOrario.fine
      chiusura++
    }

    if (chiusura < minRichiesto) {
      console.warn(`[GENERATOR] ⚠️ Copertura chiusura 20:00 scoperta il ${data}: solo ${chiusura}/${minRichiesto} presenti dopo correzione (pool di candidati esaurito, probabilmente troppe assenze simultanee) — verificare manualmente`)
    }
  }
}

/** Cerca in config.legenda_orari uno slot che copra INTERAMENTE la fascia data (default
 * 12:00-14:00) con lo stesso numero di ore del turno originale — se non esiste prova
 * ±1/±2 ore entro il max_ore_giorno del dipendente, per non alterare troppo il monte-ore
 * già assegnato (lo sconto festivi, se necessario, sistema comunque il totale dopo). */
function trovaOrarioCentrale(
  config: any,
  ore: number,
  dip: any,
  fascia: { inizio: string; fine: string }
): { inizio: string; fine: string } | null {
  const legenda: { ore: number; orario: string }[] = config?.legenda_orari ?? []
  const max = getMaxOreGiorno(dip)
  const copreInteramente = (o: { inizio: string; fine: string }) => o.inizio <= fascia.inizio && o.fine >= fascia.fine
  for (const delta of [0, 1, -1, 2, -2]) {
    const target = ore + delta
    if (target < 1 || target > max) continue
    const match = legenda
      .filter(l => l.ore === target)
      .map(l => orarioFromSlug(l.orario))
      .find(copreInteramente)
    if (match) return match
  }
  return null
}

/** FIX 2 — Fascia centrale 12:00-14:00: minimo `minimo_cassieri` presenti (config
 * regole_generali.fascia_centrale_obbligatoria). Yuri (presenza_preferita) copre già
 * 13:00-16:00 quasi tutti i giorni, ma questo da solo non copre l'intera fascia 12-14
 * (specialmente Mar/Gio, dove fa solo 13/16) — serve almeno un'altra cassiera con un
 * turno "centrale" che copra 12-14 per intero. Pass di correzione post-generazione,
 * stesso pattern di correggiChiusura: se il conteggio di chi SI SOVRAPPONE alla fascia
 * (anche parzialmente, stesso criterio del pannello "Mezzogiorno") è sotto il minimo,
 * converte il turno di una cassiera candidata (mai Yuri, mai non_cassiere, mai
 * flessibilita "Nessuna") in un orario centrale valido, preservando le ore quando
 * possibile. */
function correggiFasciaCentrale(shifts: Omit<Shift, 'id' | 'created_at'>[], employees: Employee[], config: any, festiviSet: Set<string>): void {
  const fascia = config?.regole_generali?.fascia_centrale_obbligatoria
  if (!fascia) return
  const minimo = fascia.minimo_cassieri ?? 2

  const perGiorno: Record<string, Omit<Shift, 'id' | 'created_at'>[]> = {}
  for (const s of shifts) {
    if (!perGiorno[s.data]) perGiorno[s.data] = []
    perGiorno[s.data].push(s)
  }

  for (const [data, dayShifts] of Object.entries(perGiorno)) {
    if (new Date(data + 'T00:00:00').getDay() === 0) continue // domenica non gestita da questa regola
    if (festiviSet.has(data)) continue // negozio chiuso, nessuna copertura attesa

    let overlap = dayShifts.filter(s =>
      s.ora_inizio && s.ora_fine && s.ora_inizio < fascia.fine && s.ora_fine > fascia.inizio
    )
    if (overlap.length >= minimo) continue

    const candidati = dayShifts
      .filter(s => {
        const emp = employees.find(e => e.id === s.employee_id)
        if (!emp) return false
        const nome = emp.nome.trim()
        if (nome === fascia.presenza_preferita) return false // Yuri, mai spostare
        const dip = findDip(config, nome)
        const esclusoStrutturale = dip?.ruolo === 'non_cassiere'
          || (dip?.flessibilita ?? '').toLowerCase().includes('nessuna')
        if (esclusoStrutturale) return false
        if (s.tipo !== 'mattina' && s.tipo !== 'pomeriggio') return false
        const copreGia = s.ora_inizio! <= fascia.inizio && s.ora_fine! >= fascia.fine
        return !copreGia
      })
      .sort((a, b) => oreFromOrario(b.ora_inizio, b.ora_fine) - oreFromOrario(a.ora_inizio, a.ora_fine))

    for (const s of candidati) {
      if (overlap.length >= minimo) break
      const emp = employees.find(e => e.id === s.employee_id)!
      const dip = findDip(config, emp.nome.trim())
      const ore = oreFromOrario(s.ora_inizio, s.ora_fine)
      const nuovoOrario = trovaOrarioCentrale(config, ore, dip, fascia)
      if (!nuovoOrario) continue
      s.ora_inizio = nuovoOrario.inizio
      s.ora_fine = nuovoOrario.fine
      overlap = [...overlap, s]
    }

    if (overlap.length < minimo) {
      console.warn(`[GENERATOR] ⚠️ Fascia centrale ${fascia.inizio}-${fascia.fine} scoperta il ${data}: solo ${overlap.length}/${minimo} presenti dopo correzione — verificare manualmente`)
    }
  }
}

/** FIX 2 (21/08/2026, richiesta esplicita Giacomo) — Fascia obbligatoria cassa
 * 13:00-16:00 come vincolo ASSOLUTO: Yuri + almeno N-1 altri cassieri quando
 * Yuri lavora, 2 cassieri qualsiasi quando Yuri è assente/ferie. Prima era
 * SOLO verificata (console.warn, mai corretta — commento originale: "un vero
 * auto-fix richiederebbe un constraint solver"). Ora è un vero pass di
 * correzione, stesso identico pattern di correggiFasciaCentrale (12-14): se
 * la copertura piena (non solo overlap) è sotto il minimo, converte il turno
 * di una cassiera candidata (mai Yuri — la sua presenza quando lavora conta
 * già naturalmente nel conteggio, la regola "Yuri + 1 altro" emerge da sola:
 * se Yuri è in turno quel giorno la fascia è già coperta da lui, serve solo
 * completare il minimo; se Yuri è assente il minimo va raggiunto interamente
 * dagli altri) in un orario che copre 13-16 per intero, cercato in
 * config.legenda_orari con lo stesso helper trovaOrarioCentrale già usato per
 * la fascia 12-14. */
function correggiFasciaObbligatoria(shifts: Omit<Shift, 'id' | 'created_at'>[], employees: Employee[], config: any, festiviSet: Set<string>): void {
  const fascia = config?.regole_generali?.fascia_obbligatoria_cassa
  if (!fascia) return
  const minimo = fascia.minimo_cassieri ?? 2
  const cop = config?.regole_generali?.copertura_chiusura ?? { lun_ven: 3, sabato: 4 }

  const perGiorno: Record<string, Omit<Shift, 'id' | 'created_at'>[]> = {}
  for (const s of shifts) {
    if (!perGiorno[s.data]) perGiorno[s.data] = []
    perGiorno[s.data].push(s)
  }

  for (const [data, dayShifts] of Object.entries(perGiorno)) {
    const dow = new Date(data + 'T00:00:00').getDay()
    if (dow === 0) continue
    if (festiviSet.has(data)) continue

    let presenti = dayShifts.filter(s =>
      s.ora_inizio && s.ora_fine && s.ora_inizio <= fascia.inizio && s.ora_fine >= fascia.fine
    )
    if (presenti.length >= minimo) continue

    // 🐛 21/08/2026 — trovaOrarioCentrale può assegnare un orario che non
    // finisce più alle 20:00 (es. sposta un turno 14-20 a 11-16 per coprire
    // 13-16) — se quella persona serviva alla copertura chiusura già
    // corretta da correggiChiusura (che gira PRIMA), la romperebbe
    // silenziosamente. Stessa protezione già applicata a
    // correggiBilanciamentoMattinaPomeriggio.
    const minChiusura = dow === 6 ? cop.sabato : cop.lun_ven
    let chiusuraCount = dayShifts.filter(s => s.ora_fine === '20:00').length

    const candidati = dayShifts
      .filter(s => {
        const emp = employees.find(e => e.id === s.employee_id)
        if (!emp) return false
        const nome = emp.nome.trim()
        if (nome === fascia.presenza_preferita) return false // Yuri, mai spostare — la sua fascia è già fissa
        const dip = findDip(config, nome)
        const esclusoStrutturale = dip?.ruolo === 'non_cassiere'
          || (dip?.flessibilita ?? '').toLowerCase().includes('nessuna')
        if (esclusoStrutturale) return false
        if (s.tipo !== 'mattina' && s.tipo !== 'pomeriggio') return false
        const copreGia = s.ora_inizio! <= fascia.inizio && s.ora_fine! >= fascia.fine
        if (copreGia) return false
        if (s.ora_fine === '20:00' && chiusuraCount <= minChiusura) return false // non disfare la copertura chiusura
        return true
      })
      .sort((a, b) => oreFromOrario(b.ora_inizio, b.ora_fine) - oreFromOrario(a.ora_inizio, a.ora_fine))

    for (const s of candidati) {
      if (presenti.length >= minimo) break
      if (s.ora_fine === '20:00' && chiusuraCount <= minChiusura) continue
      const emp = employees.find(e => e.id === s.employee_id)!
      const dip = findDip(config, emp.nome.trim())
      const ore = oreFromOrario(s.ora_inizio, s.ora_fine)
      const nuovoOrario = trovaOrarioCentrale(config, ore, dip, fascia)
      if (!nuovoOrario) continue
      const finivaAlleChiusura = s.ora_fine === '20:00'
      s.ora_inizio = nuovoOrario.inizio
      s.ora_fine = nuovoOrario.fine
      if (finivaAlleChiusura && s.ora_fine !== '20:00') chiusuraCount--
      presenti = [...presenti, s]
    }

    if (presenti.length < minimo) {
      console.warn(`[GENERATOR] ⚠️ Fascia obbligatoria ${fascia.inizio}-${fascia.fine} scoperta il ${data}: solo ${presenti.length}/${minimo} presenti dopo correzione — verificare manualmente`)
    }
  }
}

/** FIX 3 (21/08/2026, richiesta esplicita Giacomo) — Bilanciamento mattina/
 * pomeriggio: la mattina deve avere sempre almeno lo stesso numero di persone
 * del pomeriggio (mai il contrario), conteggio totale giornaliero su tutti i
 * reparti/ruoli. "Mattina"/"pomeriggio" sono definiti dall'ORARIO effettivo
 * (non dalla stringa `tipo`, che varia troppo tra i rami del generatore —
 * mattina, mattina_corta, full, spezzato_mattina, valori "yuri_*" letti da
 * config...): un turno conta come mattina se copre almeno un minuto prima
 * delle 14:00, come pomeriggio se copre almeno un minuto dopo le 14:00 — un
 * turno lungo (full, o Yuri se il suo pattern quel giorno è più ampio di
 * 13-16) conta in ENTRAMBI, un turno spezzato conta una volta per riga (la
 * persona ha coperto davvero entrambe le metà).
 * Eseguito PER ULTIMO tra i pass strutturali (dopo le due fasce orarie e
 * dopo correggiChiusura): non tocca MAI un turno che sta coprendo per intero
 * la fascia_obbligatoria_cassa o la fascia_centrale_obbligatoria di quel
 * giorno, né un turno che finisce alle 20:00 SE serve a soddisfare la
 * copertura chiusura minima di quel giorno — per non disfare le correzioni
 * già applicate sopra. Esclude anche Yuri (fascia fissa) e Gilda/Tony
 * (pattern_standard.lun_sab — fissi mattina per contratto, come da esempio
 * esplicito nella richiesta).
 * 🐛 21/08/2026 — bug trovato in fase di test (18 violazioni chiusura su dati
 * reali dopo aver aggiunto questo pass): senza la protezione sulla chiusura,
 * questa funzione riconvertiva a mattina esattamente i turni che
 * correggiChiusura aveva appena spostato a pomeriggio per raggiungere il
 * minimo, disfacendo quella correzione. Corretto PRIMA del deploy — mai
 * arrivato in produzione. */
function correggiBilanciamentoMattinaPomeriggio(shifts: Omit<Shift, 'id' | 'created_at'>[], employees: Employee[], config: any, festiviSet: Set<string>): void {
  const perGiorno: Record<string, Omit<Shift, 'id' | 'created_at'>[]> = {}
  for (const s of shifts) {
    if (!perGiorno[s.data]) perGiorno[s.data] = []
    perGiorno[s.data].push(s)
  }

  const fasciaObbl = config?.regole_generali?.fascia_obbligatoria_cassa
  const fasciaCentr = config?.regole_generali?.fascia_centrale_obbligatoria
  const cop = config?.regole_generali?.copertura_chiusura ?? { lun_ven: 3, sabato: 4 }

  const copreFasciaProtetta = (s: Omit<Shift, 'id' | 'created_at'>): boolean => {
    if (!s.ora_inizio || !s.ora_fine) return false
    if (fasciaObbl && s.ora_inizio <= fasciaObbl.inizio && s.ora_fine >= fasciaObbl.fine) return true
    if (fasciaCentr && s.ora_inizio <= fasciaCentr.inizio && s.ora_fine >= fasciaCentr.fine) return true
    return false
  }

  const isMattina = (s: Omit<Shift, 'id' | 'created_at'>) => !!s.ora_inizio && s.ora_inizio < '14:00'
  const isPomeriggio = (s: Omit<Shift, 'id' | 'created_at'>) => !!s.ora_fine && s.ora_fine > '14:00'

  for (const [data, dayShifts] of Object.entries(perGiorno)) {
    const dow = new Date(data + 'T00:00:00').getDay()
    if (dow === 0) continue
    if (festiviSet.has(data)) continue

    const minChiusura = dow === 6 ? cop.sabato : cop.lun_ven
    let chiusuraCount = dayShifts.filter(s => s.ora_fine === '20:00').length

    let mattinaCount = dayShifts.filter(isMattina).length
    let pomeriggioCount = dayShifts.filter(isPomeriggio).length
    if (pomeriggioCount <= mattinaCount) continue

    const candidati = dayShifts
      .filter(s => {
        const emp = employees.find(e => e.id === s.employee_id)
        if (!emp) return false
        const nome = emp.nome.trim()
        if (nome === (fasciaObbl?.presenza_preferita ?? 'Yuri')) return false
        const dip = findDip(config, nome)
        if ((dip?.flessibilita ?? '').toLowerCase().includes('nessuna')) return false
        if (dip?.pattern_standard?.lun_sab) return false // Gilda/Tony, fissi mattina — mai da toccare qui
        if (!isPomeriggio(s) || isMattina(s)) return false // deve essere SOLO pomeriggio
        if (copreFasciaProtetta(s)) return false // non disfare le fasce orarie già corrette sopra
        if (s.ora_fine === '20:00' && chiusuraCount <= minChiusura) return false // non disfare la copertura chiusura già corretta sopra
        return true
      })
      .sort((a, b) => oreFromOrario(b.ora_inizio, b.ora_fine) - oreFromOrario(a.ora_inizio, a.ora_fine))

    for (const s of candidati) {
      if (pomeriggioCount <= mattinaCount) break
      if (s.ora_fine === '20:00' && chiusuraCount <= minChiusura) continue // ricontrollo: chiusuraCount può essere sceso durante il loop
      const emp = employees.find(e => e.id === s.employee_id)!
      const dip = findDip(config, emp.nome.trim())
      const ore = oreFromOrario(s.ora_inizio, s.ora_fine)
      const isCassiera22 = dip?.alternanza?.gruppo === '22h'
      const nuovoOrario = isCassiera22 ? orarioMattinaFlessibile(ore) : orarioMattina(ore)
      const finivaAlleChiusura = s.ora_fine === '20:00'
      s.tipo = 'mattina'
      s.ora_inizio = nuovoOrario.inizio
      s.ora_fine = nuovoOrario.fine
      if (finivaAlleChiusura) chiusuraCount--
      mattinaCount++
      pomeriggioCount--
    }

    if (pomeriggioCount > mattinaCount) {
      console.warn(`[GENERATOR] ⚠️ Bilanciamento mattina/pomeriggio non raggiunto il ${data}: mattina=${mattinaCount} pomeriggio=${pomeriggioCount} (nessun candidato convertibile senza rompere altre regole) — verificare manualmente`)
    }
  }
}

/** Numero di settimana ISO (usato come chiave di cache per la distribuzione ore di Carlo —
 * non più per l'alternanza Max/Romeo, che ora usa getWeekIndex ancorato a turni_alternanza). */
function getIsoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
}

function getDaysInMonth(anno: number, mese: number): Date[] {
  const days: Date[] = []
  const date = new Date(anno, mese - 1, 1)
  while (date.getMonth() === mese - 1) {
    days.push(new Date(date))
    date.setDate(date.getDate() + 1)
  }
  return days
}

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0]
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX 4 (21/08/2026) — cambio riposo infrasettimanale via Maia (tool
// `sposta_riposo`, src/app/api/maia-chat/route.ts): ripristina un turno di
// lavoro "standard" nel vecchio giorno di riposo, secondo il pattern del
// dipendente. Riusa gli stessi helper del generatore vero (findDip,
// chiMattinaMaxRomeo, direzioneSabatoFormula, orarioMattina/Pomeriggio/
// FromSlug) invece di duplicarli — stessa fonte di verità.
// ─────────────────────────────────────────────────────────────────────────────

/** Calcola il turno "standard" (tipo + orario) che un dipendente farebbe in un
 * giorno feriale/sabato specifico, SENZA passare per generateShiftsMD (che
 * gira su TUTTI i dipendenti insieme e applica i pass di correzione — usarlo
 * per un solo dipendente isolato applicherebbe quei pass a un quadro parziale
 * e fasullo, es. correggiChiusura convertirebbe il turno anche se non serve
 * davvero per l'intero negozio). Copre fedelmente i pattern FISSI/calcolabili
 * in isolamento (R1 Gilda/Tony, Yuri, Denise, Max/Romeo alternanza AB,
 * Cristina/Stefania). Per Carlo e le cassiere 22h (distribuzione ore dinamica,
 * richiede il contesto dell'intera settimana per sapere quante ore restano
 * da spalmare sui giorni rimanenti — non calcolabile per un giorno isolato
 * senza rigenerare l'intera settimana) usa un fallback semplificato
 * (mattina, ore = getMaxOreGiorno) — DOCUMENTATO, non un bug nascosto: se
 * serve esattezza per questi dipendenti specifici, va rigenerata la
 * settimana con generateShiftsMDWeek invece di usare sposta_riposo. */
export async function calcolaTurnoStandardGiorno(
  emp: Pick<Employee, 'nome' | 'ore_settimanali'>, config: any, storeId: string, dataStr: string
): Promise<{ tipo: TurnoTipo; orario: { inizio: string; fine: string } } | null> {
  const nome = emp.nome.trim()
  const dip = findDip(config, nome)
  if (!dip) return null

  const d = new Date(dataStr + 'T00:00:00')
  const dayOfWeek = d.getDay()
  if (dayOfWeek === 0) return null // domenica non gestita da questa funzione — mai chiamata per un riposo infrasettimanale domenicale

  // R1 — Gilda/Tony: pattern fisso, sempre mattina.
  if (dip.pattern_standard?.lun_sab) {
    const slot = dip.pattern_standard.lun_sab
    return { tipo: 'mattina', orario: orarioFromSlug(slot.orario) }
  }

  // Yuri — pattern per-giorno esplicito in config.
  if (nome === 'Yuri') {
    const giornoKey = ['domenica', 'lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato'][dayOfWeek]
    const slot = dip.pattern_standard?.[giornoKey]
    if (slot && typeof slot === 'object') {
      return { tipo: slot.tipo as TurnoTipo, orario: orarioFromSlug(slot.orario) }
    }
    return { tipo: 'mattina', orario: orarioMattina(6) }
  }

  // Denise — 40h su 6 giorni, ore fisse per giorno, sabato con direzione alternata.
  if (nome === 'Denise') {
    const ORE_DENISE: Record<number, number> = { 1: 8, 2: 6, 3: 6, 4: 8, 5: 6, 6: 6 }
    const ore = ORE_DENISE[dayOfWeek] ?? 6
    if (dayOfWeek === 6) {
      const direzione = direzioneSabatoFormula('Denise', dataStr)
      return { tipo: direzione, orario: direzione === 'mattina' ? orarioMattina(ore) : orarioPomeriggio(ore) }
    }
    const mattinaGiorni = [1, 3, 5]
    const tipo: TurnoTipo = mattinaGiorni.includes(dayOfWeek) ? 'mattina' : 'pomeriggio'
    return { tipo, orario: tipo === 'mattina' ? orarioMattina(ore) : orarioPomeriggio(ore) }
  }

  // Max/Romeo — alternanza settimanale AB.
  if (dip.alternanza?.gruppo === 'AB') {
    const monday = getMonday(dataStr)
    const alternanza = await chiMattinaMaxRomeo(storeId, monday)
    const mattinaOra = alternanza.mattina === nome

    if (nome === 'Max') {
      const slot = mattinaOra ? dip.pattern_standard.mattina : dip.pattern_standard.pomeriggio
      const tipo: TurnoTipo = mattinaOra ? 'mattina_corta' : 'pomeriggio_corto'
      return { tipo, orario: orarioFromSlug(slot.orario) }
    }
    // Romeo
    let ore: number
    if (dayOfWeek === 6) {
      const oreFeriali = 5 + 4 + 5 + 4 + 5
      ore = Math.min(getMaxOreGiorno(dip), Math.max(5, emp.ore_settimanali - oreFeriali))
    } else {
      const giornoKey = ['', 'lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi'][dayOfWeek]
      ore = dip.pattern_standard[giornoKey]?.ore ?? 4
    }
    const tipo: TurnoTipo = mattinaOra ? 'mattina' : 'pomeriggio'
    return { tipo, orario: mattinaOra ? orarioMattina(ore) : orarioPomeriggio(ore) }
  }

  // Cristina/Stefania — sempre opposte, ore feriali da ORE_28H_FERIALI, sabato 6h fisse.
  if (nome === 'Cristina' || nome === 'Stefania') {
    const cristinaMattinaGiorni = [1, 3, 5]
    const cristinaEMattina = cristinaMattinaGiorni.includes(dayOfWeek)
    const eMattina = nome === 'Cristina' ? cristinaEMattina : !cristinaEMattina

    if (dayOfWeek === 6) {
      const direzioneCristina = direzioneSabatoFormula('Cristina', dataStr)
      const mia = nome === 'Cristina' ? direzioneCristina : (direzioneCristina === 'mattina' ? 'pomeriggio' : 'mattina')
      return { tipo: mia, orario: mia === 'mattina' ? orarioMattina(6) : orarioPomeriggio(6) }
    }
    const ore = ORE_28H_FERIALI[dayOfWeek] ?? 4
    const tipo: TurnoTipo = eMattina ? 'mattina' : 'pomeriggio'
    return { tipo, orario: eMattina ? orarioMattina(ore) : orarioPomeriggio(ore) }
  }

  // Carlo / cassiere 22h / altri — distribuzione ore dinamica, richiede il
  // contesto dell'intera settimana (vedi commento sopra la funzione).
  // Fallback semplificato e DOCUMENTATO: mattina, ore = max_ore_giorno.
  const oreFallback = getMaxOreGiorno(dip)
  const isCassiera22 = dip.alternanza?.gruppo === '22h'
  return {
    tipo: 'mattina',
    orario: isCassiera22 ? orarioMattinaFlessibile(oreFallback) : orarioMattina(oreFallback),
  }
}
