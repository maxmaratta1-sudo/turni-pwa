import {
  Employee, Shift, Unavailability, TurnoTipo, ORE_TURNO,
  MD_LANCIANO_STORE_NOME,
} from '@/types'
import { supabaseAdmin } from './supabase'

// Ore settimanali → ore mensili approssimate (Stroili)
const ORE_MENSILI = {
  20: 87,  // ~20h * 4.33 settimane
  30: 130,
  40: 173
}

interface GenerateParams {
  scheduleId: string
  employees: Employee[]
  unavailabilities: Unavailability[]
  mese: number
  anno: number
  storeNome?: string
}

export async function generateShifts(params: GenerateParams): Promise<Omit<Shift, 'id' | 'created_at'>[]> {
  if (params.storeNome === MD_LANCIANO_STORE_NOME) {
    return generateShiftsMD(params)
  }
  return generateShiftsDefault(params)
}

// ─────────────────────────────────────────────────────────────────────────────
// ALGORITMO DEFAULT — Stroili Oasi Lanciano (INVARIATO, non toccare)
// ─────────────────────────────────────────────────────────────────────────────
function generateShiftsDefault(params: GenerateParams): Omit<Shift, 'id' | 'created_at'>[] {
  const { scheduleId, employees, unavailabilities, mese, anno } = params

  const giorni = getDaysInMonth(anno, mese)
  const shifts: Omit<Shift, 'id' | 'created_at'>[] = []

  const unavailMap: Record<string, Set<string>> = {}
  for (const u of unavailabilities) {
    if (!unavailMap[u.employee_id]) unavailMap[u.employee_id] = new Set()
    unavailMap[u.employee_id].add(u.data)
  }

  const oreAssegnate: Record<string, number> = {}
  employees.forEach(e => { oreAssegnate[e.id] = 0 })

  for (const giorno of giorni) {
    const dataStr = formatDate(giorno)
    const dayOfWeek = giorno.getDay() // 0=domenica

    // Domenica: tutti riposo (negozio chiuso — da confermare con Adele)
    if (dayOfWeek === 0) {
      for (const emp of employees) {
        shifts.push({ schedule_id: scheduleId, employee_id: emp.id, data: dataStr, tipo: 'riposo' })
      }
      continue
    }

    for (const emp of employees) {
      const oreTarget = ORE_MENSILI[emp.ore_settimanali as 20 | 30 | 40]
      const oreRimanenti = oreTarget - oreAssegnate[emp.id]
      const giorniRimanenti = giorni.filter(g => g >= giorno && g.getDay() !== 0).length

      // Se ha indisponibilità → riposo
      if (unavailMap[emp.id]?.has(dataStr)) {
        shifts.push({ schedule_id: scheduleId, employee_id: emp.id, data: dataStr, tipo: 'riposo' })
        continue
      }

      // Sceglie il turno ottimale
      const tipo = chooseTurno(oreRimanenti, giorniRimanenti, emp.ore_settimanali)
      oreAssegnate[emp.id] += ORE_TURNO[tipo]

      shifts.push({
        schedule_id: scheduleId,
        employee_id: emp.id,
        data: dataStr,
        tipo,
        ora_inizio: tipo !== 'riposo' ? getTurnoOrario(tipo).inizio : undefined,
        ora_fine:   tipo !== 'riposo' ? getTurnoOrario(tipo).fine   : undefined,
      })
    }
  }

  return shifts
}

function chooseTurno(oreRimanenti: number, giorniRimanenti: number, contratto: number): TurnoTipo {
  if (giorniRimanenti === 0 || oreRimanenti <= 0) return 'riposo'

  const orePerGiorno = oreRimanenti / giorniRimanenti

  if (contratto === 40) {
    if (orePerGiorno >= 7) return 'full'
    if (orePerGiorno >= 5) return 'mattina'
    return 'riposo'
  }

  if (contratto === 30) {
    if (orePerGiorno >= 6) return 'pomeriggio'
    if (orePerGiorno >= 4) return 'mattina'
    return 'riposo'
  }

  // 20h
  if (orePerGiorno >= 5) return 'mattina'
  return 'riposo'
}

function getTurnoOrario(tipo: TurnoTipo) {
  const map: Record<string, { inizio: string; fine: string }> = {
    mattina:    { inizio: '09:00', fine: '14:00' },
    pomeriggio: { inizio: '14:00', fine: '20:00' },
    full:       { inizio: '09:00', fine: '20:00' },
    riposo:     { inizio: '', fine: '' }
  }
  return map[tipo]
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

// ── Rotazione giornaliera cassiere 22h (invariata — la config conferma solo
// l'invariante 2 mattina + 2 pomeriggio, non contraddice questa implementazione).
const PATTERN_COPPIE_22H: { mattina: string[]; pomeriggio: string[] }[] = [
  { mattina: ['Angelica', 'Elisa'], pomeriggio: ['Damiana', 'Marilena'] },
  { mattina: ['Damiana', 'Elisa'], pomeriggio: ['Angelica', 'Marilena'] },
  { mattina: ['Angelica', 'Marilena'], pomeriggio: ['Damiana', 'Elisa'] },
]

function isMattinaCassiere22Giornaliero(nome: string, dataStr: string): boolean {
  const giorno = parseInt(dataStr.split('-')[2], 10)
  const pattern = PATTERN_COPPIE_22H[(giorno - 1) % 3]
  return pattern.mattina.includes(nome)
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

  // Piano ore Lun-Ven per dipendenti a distribuzione variabile (Carlo), ricalcolato
  // ogni volta che cambia settimana ISO.
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

  for (const giorno of giorni) {
    const dataStr = formatDate(giorno)
    const dayOfWeek = giorno.getDay() // 0=domenica, 1=lunedì ... 6=sabato
    const settimana = getIsoWeek(giorno)
    const weekdayIdx = dayOfWeek - 1 // 0=Lun..4=Ven (Sabato=5 non usato qui)

    // ── Domenica: riposo per tutti — nessuna assegnazione automatica.
    if (dayOfWeek === 0) {
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

      // Max/Romeo — alternanza settimanale AB, letta da turni_alternanza (sync con Maia).
      else if (dip.alternanza?.gruppo === 'AB') {
        const alternanza = await getAlternanzaSettimana(dataStr)
        const isMax = nome === 'Max'

        if (isMax) {
          const mattinaOra = alternanza.mattina === 'Max'
          const slot = mattinaOra ? dip.pattern_standard.mattina : dip.pattern_standard.pomeriggio
          tipo = mattinaOra ? 'mattina_corta' : 'pomeriggio_corto'
          orario = orarioFromSlug(slot.orario)
        } else {
          // Romeo: sempre mattina (scarico merce fisico Lun/Mer/Ven), regola_assoluta.
          // L'"alternanza" con Max riguarda solo la direzione di Max, non Romeo stesso —
          // il pattern_standard di Romeo non ha mai una variante pomeriggio.
          if (dayOfWeek === 1 || dayOfWeek === 3 || dayOfWeek === 5) {
            const slot = dip.pattern_standard[['','lunedi','martedi','mercoledi','giovedi','venerdi','sabato'][dayOfWeek]]
            tipo = 'mattina'
            orario = orarioFromSlug(slot.orario) // 5h fisse — regola_assoluta, mai toccare
          } else if (dayOfWeek === 2 || dayOfWeek === 4) {
            const slot = dip.pattern_standard[dayOfWeek === 2 ? 'martedi' : 'giovedi']
            tipo = 'mattina'
            orario = orarioFromSlug(slot.orario)
          } else {
            // Sabato — aggiustamento finale: 28h - ore feriali fisse (23h) = 5h, con
            // flessibilità fino a max_ore_giorno (6h, B risolto: JSON ha ragione).
            const oreFeriali = 5 + 4 + 5 + 4 + 5
            const oreSabato = Math.min(getMaxOreGiorno(dip), Math.max(5, emp.ore_settimanali - oreFeriali))
            tipo = 'mattina'
            orario = orarioMattina(oreSabato)
          }
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

      // Cassiere 22h — rotazione giornaliera a coppie mattina/pomeriggio, ore da
      // distribuzione, inizio mattina flessibile 08/09/10/11 (H).
      else if (dip.alternanza?.gruppo === '22h') {
        const mattinaOra = isMattinaCassiere22Giornaliero(nome, dataStr)
        if (dayOfWeek === 6) {
          // Sabato: durata FISSA a 5h (il budget settimanale la assume fissa — vedi
          // oreSettimanaliFeriali sotto). L'inizio flessibile (H) si applica solo ai
          // feriali: usarlo qui end-anchorato a 13:00 accorcerebbe la durata invece di
          // spostare solo l'inizio (bug trovato in test — Damiana/Elisa sotto budget).
          tipo = mattinaOra ? 'mattina' : 'pomeriggio'
          orario = mattinaOra ? orarioMattinaFlessibile(5) : orarioPomeriggio(5)
        } else {
          const max = getMaxOreGiorno(dip)
          const min = MIN_ORE_PER_CONTRATTO[emp.ore_settimanali] ?? 3
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

  correggiChiusura(shifts, employees, config)
  verificaFasciaObbligatoria(shifts, config, giorni)
  verificaBudgetSettimanale(shifts, employees)

  return shifts
}

/** Controllo di sicurezza (solo warning, non blocca): somma le ore settimanali
 * generate per ogni dipendente e segnala scostamenti da ore_contratto. Aggiunto
 * dopo aver trovato un bug reale in test (sabato 22h con inizio flessibile che
 * accorciava la durata invece di spostare solo l'inizio — vedi fix in questo file). */
function verificaBudgetSettimanale(shifts: Omit<Shift, 'id' | 'created_at'>[], employees: Employee[]): void {
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
      if (ore !== emp.ore_settimanali) {
        console.warn(`[GENERATOR] ⚠️ ${emp.nome.trim()} settimana ISO ${settimana}: ${ore}h generate invece di ${emp.ore_settimanali}h (ore_contratto) — verificare manualmente`)
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
    scheduleId, employees, unavailabilities, mese, anno, storeNome: MD_LANCIANO_STORE_NOME,
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
 * Yuri per la fascia obbligatoria, e Romeo nei suoi giorni di scarico merce) in pomeriggio
 * a parità di ore già assegnate. */
function correggiChiusura(shifts: Omit<Shift, 'id' | 'created_at'>[], employees: Employee[], config: any): void {
  const perGiorno: Record<string, Omit<Shift, 'id' | 'created_at'>[]> = {}
  for (const s of shifts) {
    if (!perGiorno[s.data]) perGiorno[s.data] = []
    perGiorno[s.data].push(s)
  }

  const cop = config?.regole_generali?.copertura_chiusura ?? { lun_ven: 3, sabato: 4 }

  for (const [data, dayShifts] of Object.entries(perGiorno)) {
    const isSabato = new Date(data + 'T00:00:00').getDay() === 6
    const minRichiesto = isSabato ? cop.sabato : cop.lun_ven
    let chiusura = dayShifts.filter(s => s.ora_fine === '20:00').length
    if (chiusura >= minRichiesto) continue

    const dayOfWeek = new Date(data + 'T00:00:00').getDay()
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
        // Romeo: Lun/Mer/Ven sono scarico merce, regola assoluta — mai convertire.
        if (nome === 'Romeo' && (dayOfWeek === 1 || dayOfWeek === 3 || dayOfWeek === 5)) return false
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
  }
}

/** K — Verifica (non correzione) della fascia obbligatoria cassa 13:00-16:00: Yuri +
 * almeno N-1 altri cassieri presenti. Logga un warning se scoperta — un vero
 * auto-fix richiederebbe un constraint solver (vedi Opus, Step 3). */
function verificaFasciaObbligatoria(shifts: Omit<Shift, 'id' | 'created_at'>[], config: any, giorni: Date[]): void {
  const fascia = config?.regole_generali?.fascia_obbligatoria_cassa
  if (!fascia) return

  for (const giorno of giorni) {
    if (giorno.getDay() === 0) continue
    const dataStr = formatDate(giorno)
    const presenti = shifts.filter(s =>
      s.data === dataStr && s.ora_inizio && s.ora_fine &&
      s.ora_inizio <= fascia.inizio && s.ora_fine >= fascia.fine
    )
    if (presenti.length < (fascia.minimo_cassieri ?? 2)) {
      console.warn(`[GENERATOR] ⚠️ Fascia obbligatoria ${fascia.inizio}-${fascia.fine} scoperta il ${dataStr}: solo ${presenti.length}/${fascia.minimo_cassieri} presenti`)
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
