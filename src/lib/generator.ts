import {
  Employee, Shift, Unavailability, TurnoTipo, ORE_TURNO,
  ORARI_TURNO_MD, MD_LANCIANO_STORE_NOME,
} from '@/types'

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

export function generateShifts(params: GenerateParams): Omit<Shift, 'id' | 'created_at'>[] {
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
// ALGORITMO MD LANCIANO — ore esatte (numeri interi) + vincoli orario negozio
// ─────────────────────────────────────────────────────────────────────────────
//
// DOMENICA: non gestita da questo algoritmo. Ogni domenica è sempre "riposo" di
// default per tutti — i turni domenicali (domenica_lungo/domenica_corto) vengono
// assegnati SOLO manualmente da Giacomo (click sulla cella o tramite Maia).
//
// VINCOLI ORARIO NEGOZIO (assoluti): apertura 08:00, chiusura 20:00.
// - Turno mattina: inizio 08:00, fine = 08:00 + ore (start-anchored)
// - Turno mattina cassiere 22h: FINE fissa alle 13:00, inizio = 13:00 - ore
//   (end-anchored — coerente con gli esempi forniti: 3h→10/13, 4h→9/13, 5h→8/13)
// - Turno pomeriggio: fine sempre 20:00, inizio = 20:00 - ore (end-anchored)
//   → soddisfa automaticamente "mai iniziare oltre le 17:00" per ore ≥ 3h
//
// Distribuzione ore intere sui 5 giorni feriali (Lun-Ven) — il Sabato ha ore fisse
// per contratto e viene sottratto PRIMA di distribuire il resto:
const CONFIG_ORE_CONTRATTO: Record<number, { sabato: number; min: number; max: number }> = {
  22: { sabato: 5, min: 3, max: 5 },
  28: { sabato: 6, min: 4, max: 6 },
  30: { sabato: 6, min: 4, max: 6 }, // Cristina — per analogia con 28h, non specificato esplicitamente
  35: { sabato: 6, min: 5, max: 6 },
  36: { sabato: 6, min: 6, max: 6 }, // Gilda/Tony — fisso, nessuna variazione (gestito comunque da R1)
}

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

/** Orario mattina standard: inizio 08:00 fisso, fine = 08:00 + ore. */
function orarioMattina(ore: number): { inizio: string; fine: string } {
  return { inizio: '08:00', fine: formatOra(8 + ore) }
}

/** Orario mattina cassiere 22h: fine fissa 13:00, inizio flessibile = 13:00 - ore. */
function orarioMattinaFlessibile(ore: number): { inizio: string; fine: string } {
  return { inizio: formatOra(13 - ore), fine: '13:00' }
}

/** Orario pomeriggio: fine sempre 20:00 (chiusura negozio), inizio = 20:00 - ore. */
function orarioPomeriggio(ore: number): { inizio: string; fine: string } {
  return { inizio: formatOra(20 - ore), fine: '20:00' }
}

// Cassiere 22h: 2 gruppi fissi (mattina/pomeriggio), invertiti a settimane alterne —
// garantisce SEMPRE 2 di mattina + 2 di pomeriggio ogni giorno, mai tutte sullo stesso turno.
const CASSIERE22_GRUPPO_A = ['Angelica', 'Elisa']       // mattina quando la settimana è pari
const CASSIERE22_GRUPPO_B = ['Damiana', 'Marilena']     // pomeriggio quando la settimana è pari

function isMattinaCassiere22(nome: string, weekIsEven: boolean): boolean {
  const inGruppoA = CASSIERE22_GRUPPO_A.includes(nome)
  return weekIsEven ? inGruppoA : !inGruppoA
}

// Alternanza sabati (settimane pari/dispari) — Carlo e il "gruppo 2" alternano
// mattina/pomeriggio del sabato invece di avere una direzione fissa. Yuri resta
// SEMPRE mattina 08-14 di sabato (regola propria, non tocca questa alternanza).
const ALTERNANZA_SABATO_GRUPPO2 = ['Angelica', 'Damiana', 'Elisa', 'Marilena', 'Cristina', 'Stefania']

/** Direzione sabato per il "gruppo 2": metà del gruppo mattina, metà pomeriggio,
 * si invertono a settimane alterne (weekIsEven). */
function direzioneSabatoGruppo2(nome: string, weekIsEven: boolean): boolean {
  const idx = ALTERNANZA_SABATO_GRUPPO2.indexOf(nome)
  const isFirstHalf = idx >= 0 && idx < Math.ceil(ALTERNANZA_SABATO_GRUPPO2.length / 2)
  return weekIsEven ? isFirstHalf : !isFirstHalf
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

// NOTE — semplificazioni rispetto alla specifica ideale (documentate esplicitamente):
// - R6/R7 (copertura minima cassieri fascia 13-16 e chiusura 20:00, min. 3/4 persone):
//   NON verificate algoritmicamente giorno per giorno — vanno controllate a vista dopo
//   la generazione. Servirebbe un vero constraint solver per garantirle in automatico.
// - 30h (Cristina): il brief non specifica esplicitamente sabato/min/max per questo
//   contratto — ho usato gli stessi parametri del 28h per analogia (sabato 6h, 4-6h/gg).
// - Carlo (35h): Mar/Gio restano obbligatoriamente mattina come da R2, ma le ORE di quei
//   due giorni vengono comunque prese dalla distribuzione settimanale (non sono extra).
// - Direzione mattina/pomeriggio per Cristina/Stefania resta sui giorni fissi
//   (Lun/Mer/Ven mattina, Mar/Gio/Sab pomeriggio); per le 22h resta la rotazione a
//   coppie (giorno+indice)%4; per Romeo resta l'alternanza settimanale con Max.
//   Solo le ORE per ogni giorno ora vengono dalla distribuzione intera, non più fisse a 6h.
//
function generateShiftsMD(params: GenerateParams): Omit<Shift, 'id' | 'created_at'>[] {
  const { scheduleId, employees, unavailabilities, mese, anno } = params

  const giorni = getDaysInMonth(anno, mese)
  const shifts: Omit<Shift, 'id' | 'created_at'>[] = []

  const unavailMap: Record<string, Set<string>> = {}
  for (const u of unavailabilities) {
    if (!unavailMap[u.employee_id]) unavailMap[u.employee_id] = new Set()
    unavailMap[u.employee_id].add(u.data)
  }

  // Per ogni dipendente con distribuzione variabile, precalcola il piano ore Lun-Ven
  // PER SETTIMANA ISO (si ricalcola ogni volta che cambia settimana, azzerando il piano).
  const pianoSettimanale: Record<string, { settimana: number; oreGiorni: number[]; usati: number }> = {}

  function getPianoGiorno(emp: Employee, settimana: number, weekdayIdx: number): number {
    // weekdayIdx: 0=Lun,1=Mar,2=Mer,3=Gio,4=Ven
    const key = emp.id
    const cfg = CONFIG_ORE_CONTRATTO[emp.ore_settimanali]
    if (!cfg) return 6 // fallback

    let piano = pianoSettimanale[key]
    if (!piano || piano.settimana !== settimana) {
      const oreRimanenti = Math.max(0, emp.ore_settimanali - cfg.sabato)
      piano = { settimana, oreGiorni: distribuisciOre(oreRimanenti, 5, cfg.min, cfg.max), usati: 0 }
      pianoSettimanale[key] = piano
    }
    return piano.oreGiorni[weekdayIdx] ?? 0
  }

  for (const giorno of giorni) {
    const dataStr = formatDate(giorno)
    const dayOfWeek = giorno.getDay() // 0=domenica, 1=lunedì ... 6=sabato
    const settimana = getIsoWeek(giorno)
    const weekIsEven = settimana % 2 === 0
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
      // Indisponibilità dichiarata → riposo
      if (unavailMap[emp.id]?.has(dataStr)) {
        shifts.push({ schedule_id: scheduleId, employee_id: emp.id, data: dataStr, tipo: 'riposo' })
        continue
      }

      let tipo: TurnoTipo = 'riposo'
      let orario: { inizio: string; fine: string } | null = null

      // R1 — Gilda e Tony: sempre mattina 08:00-14:00, mai domenica (già escluse sopra).
      if (emp.turno_fisso === 'mattina') {
        tipo = 'mattina'
        orario = orarioMattina(6)
      }
      // R1 — Yuri: Lun/Mer/Ven 08-16, Mar/Gio 13-16 (mattina in salumeria), Sab 08-14.
      // Regola assoluta fissa — non passa dalla distribuzione ore intere.
      else if (emp.nome === 'Yuri') {
        if (dayOfWeek === 1 || dayOfWeek === 3 || dayOfWeek === 5) { tipo = 'yuri_full'; orario = ORARI_TURNO_MD.yuri_full! }
        else if (dayOfWeek === 2 || dayOfWeek === 4) { tipo = 'yuri_pomeriggio'; orario = ORARI_TURNO_MD.yuri_pomeriggio! }
        else { tipo = 'mattina'; orario = orarioMattina(6) } // sabato
      }
      // R3 — Alternanza Max/Romeo. Max: 5h fisse (regola propria, mattina_corta/pomeriggio_corto).
      else if (emp.alternanza_gruppo === 'AB') {
        const isMax = emp.nome === 'Max'
        const mattinaOra = weekIsEven ? isMax : !isMax
        if (isMax) {
          tipo = mattinaOra ? 'mattina_corta' : 'pomeriggio_corto'
          orario = ORARI_TURNO_MD[tipo]!
        } else if (dayOfWeek === 6) {
          // Sabato Romeo: 6h fisse (28h) — direzione di default mattina
          tipo = mattinaOra ? 'mattina' : 'pomeriggio'
          orario = mattinaOra ? orarioMattina(6) : orarioPomeriggio(6)
        } else {
          const ore = getPianoGiorno(emp, settimana, weekdayIdx)
          if (ore <= 0) { tipo = 'riposo'; orario = null }
          else {
            tipo = mattinaOra ? 'mattina' : 'pomeriggio'
            orario = mattinaOra ? orarioMattina(ore) : orarioPomeriggio(ore)
          }
        }
      }
      // R2 — Carlo (35h): Mar/Gio obbligatoriamente mattina, altri giorni preferenza mattina.
      else if (emp.nome === 'Carlo') {
        if (dayOfWeek === 6) {
          // Sabato: alterna mattina/pomeriggio a settimane alterne (indipendente da Yuri).
          tipo = weekIsEven ? 'mattina' : 'pomeriggio'
          orario = weekIsEven ? orarioMattina(6) : orarioPomeriggio(6)
        } else {
          const ore = getPianoGiorno(emp, settimana, weekdayIdx)
          if (ore <= 0) { tipo = 'riposo'; orario = null }
          else { tipo = 'mattina'; orario = orarioMattina(ore) } // sempre preferenza mattina
        }
      }
      // R4 — Cassiere 22h: rotazione a coppie mattina/pomeriggio, ore variabili da distribuzione.
      // Mattina = orario flessibile end-anchored a 13:00 (vedi orarioMattinaFlessibile).
      else if (emp.priorita_cassa === 1) {
        const mattinaOra = isMattinaCassiere22(emp.nome, weekIsEven)
        if (dayOfWeek === 6) {
          // Sabato: sempre 5h, direzione alternata a settimane alterne (gruppo 2).
          const mattinaSabato = direzioneSabatoGruppo2(emp.nome, weekIsEven)
          tipo = mattinaSabato ? 'mattina' : 'pomeriggio'
          orario = mattinaSabato ? { inizio: '08:00', fine: '13:00' } : orarioPomeriggio(5)
        } else {
          const ore = getPianoGiorno(emp, settimana, weekdayIdx)
          if (ore <= 0) { tipo = 'riposo'; orario = null }
          else {
            tipo = mattinaOra ? 'mattina' : 'pomeriggio'
            orario = mattinaOra ? orarioMattinaFlessibile(ore) : orarioPomeriggio(ore)
          }
        }
      }
      // R5 — Cristina (30h) e Stefania (28h): giorni fissi Lun/Mer/Ven mattina, Mar/Gio/Sab pomeriggio.
      else if (emp.priorita_cassa === 2 || emp.priorita_cassa === 3) {
        const mattinaGiorni = [1, 3, 5]
        const mattinaOra = mattinaGiorni.includes(dayOfWeek)
        if (dayOfWeek === 6) {
          // Sabato: sempre 6h, direzione alternata a settimane alterne (gruppo 2).
          const mattinaSabato = direzioneSabatoGruppo2(emp.nome, weekIsEven)
          tipo = mattinaSabato ? 'mattina' : 'pomeriggio'
          orario = mattinaSabato ? orarioMattina(6) : orarioPomeriggio(6)
        } else {
          const ore = getPianoGiorno(emp, settimana, weekdayIdx)
          if (ore <= 0) { tipo = 'riposo'; orario = null }
          else {
            tipo = mattinaOra ? 'mattina' : 'pomeriggio'
            orario = mattinaOra ? orarioMattina(ore) : orarioPomeriggio(ore)
          }
        }
      }
      // Fallback per eventuali dipendenti non coperti dalle regole sopra
      else {
        const cfg = CONFIG_ORE_CONTRATTO[emp.ore_settimanali]
        const oreDef = cfg ? Math.round((emp.ore_settimanali - cfg.sabato) / 5) : 6
        if (dayOfWeek === 6 && cfg) {
          tipo = 'mattina'
          orario = orarioMattina(cfg.sabato)
        } else {
          tipo = dayOfWeek % 2 === 0 ? 'mattina' : 'pomeriggio'
          orario = tipo === 'mattina' ? orarioMattina(oreDef) : orarioPomeriggio(oreDef)
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

  correggiChiusura(shifts, employees)

  return shifts
}

/** R7 — Chiusura 20:00: minimo 3 persone (sabato 4). Pass di correzione post-generazione:
 * se un giorno non raggiunge la copertura minima, converte turni mattina di cassiere
 * (mai Gilda/Tony/Yuri/Max, regole fisse) in pomeriggio a parità di ore già assegnate. */
function correggiChiusura(shifts: Omit<Shift, 'id' | 'created_at'>[], employees: Employee[]): void {
  const perGiorno: Record<string, Omit<Shift, 'id' | 'created_at'>[]> = {}
  for (const s of shifts) {
    if (!perGiorno[s.data]) perGiorno[s.data] = []
    perGiorno[s.data].push(s)
  }

  for (const [data, dayShifts] of Object.entries(perGiorno)) {
    const isSabato = new Date(data + 'T00:00:00').getDay() === 6
    const minRichiesto = isSabato ? 4 : 3
    let chiusura = dayShifts.filter(s => s.ora_fine === '20:00').length
    if (chiusura >= minRichiesto) continue

    const candidati = dayShifts
      .filter(s => {
        const emp = employees.find(e => e.id === s.employee_id)
        if (!emp || ['Gilda', 'Tony', 'Yuri', 'Max'].includes(emp.nome)) return false
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

/** Numero di settimana ISO (usato per l'alternanza settimanale Max/Romeo e 28h). */
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
