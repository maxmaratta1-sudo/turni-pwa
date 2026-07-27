import {
  Employee, Shift, Unavailability, TurnoTipo, ORE_TURNO,
  ORE_TURNO_MD, ORARI_TURNO_MD, ORE_MENSILI_MD, MD_LANCIANO_STORE_NOME,
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
// ALGORITMO MD LANCIANO — R1-R6
// ─────────────────────────────────────────────────────────────────────────────
//
// NOTE — semplificazioni rispetto alla specifica ideale (documentate esplicitamente):
// - R4 (copertura minima 3 cassieri nelle fasce 08-13 e 17-20): garantita euristicamente
//   dalla combinazione turno_fisso/alternanza/priorita_cassa sotto, ma non verificata
//   algoritmicamente giorno per giorno — va controllata a vista dopo la generazione.
// - R5 (rotazione domenicale): usa un pool ordinato per id + un contatore "ogni 5" per
//   Yuri; è una rotazione deterministica ma semplice, non ottimizzata per equità esatta
//   nel lungo periodo.
// - R5 (giorno compensativo con "stesse ore" della domenica): il giorno compensativo è
//   trattato come riposo pieno nel calendario (cella "—"), ma le ore già accreditate dalla
//   domenica riducono correttamente il target mensile — quindi il totale ore è corretto,
//   anche se in cella non si vede visivamente "riposo da 5h" vs "riposo da 3h".
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

  const oreAssegnate: Record<string, number> = {}
  employees.forEach(e => { oreAssegnate[e.id] = 0 })

  const yuri = employees.find(e => e.nome === 'Yuri')
  const cassieri22 = employees.filter(e => e.priorita_cassa === 1)
  const cassieri28 = employees.filter(e => e.priorita_cassa === 2)

  // Pool di rotazione domenicale (tutti tranne Yuri, che ha una cadenza propria)
  const rotationPool = employees.filter(e => e.nome !== 'Yuri').map(e => e.id)
  let rotationOffset = 0
  let sundayCounter = 0

  // Giorno compensativo pendente: employee_id → true (da consumare come riposo nella settimana)
  const compensatorioPendente: Record<string, boolean> = {}

  for (const giorno of giorni) {
    const dataStr = formatDate(giorno)
    const dayOfWeek = giorno.getDay() // 0 = domenica
    const weekIsEven = getIsoWeek(giorno) % 2 === 0

    // ── R5 — Domenica: 3 persone lavorano, il resto riposa ──────────────────
    if (dayOfWeek === 0) {
      const workers: { emp: Employee; tipo: TurnoTipo }[] = []
      const yuriTurn = !!yuri && sundayCounter % 5 === 0
      if (yuriTurn && yuri) workers.push({ emp: yuri, tipo: 'domenica_lungo' })

      const slotsLeft = 3 - workers.length
      for (let i = 0; i < slotsLeft && rotationPool.length > 0; i++) {
        const empId = rotationPool[(rotationOffset + i) % rotationPool.length]
        const emp = employees.find(e => e.id === empId)
        if (!emp) continue
        workers.push({ emp, tipo: i < slotsLeft - 1 ? 'domenica_lungo' : 'domenica_corto' })
      }
      rotationOffset = (rotationOffset + slotsLeft) % Math.max(rotationPool.length, 1)
      sundayCounter++

      for (const emp of employees) {
        const worker = workers.find(w => w.emp.id === emp.id)
        if (worker) {
          const orario = ORARI_TURNO_MD[worker.tipo]!
          oreAssegnate[emp.id] += ORE_TURNO_MD[worker.tipo]
          compensatorioPendente[emp.id] = true
          shifts.push({
            schedule_id: scheduleId, employee_id: emp.id, data: dataStr, tipo: worker.tipo,
            ora_inizio: orario.inizio, ora_fine: orario.fine,
          })
        } else {
          shifts.push({ schedule_id: scheduleId, employee_id: emp.id, data: dataStr, tipo: 'riposo' })
        }
      }
      continue
    }

    // ── Giorno feriale ────────────────────────────────────────────────────────
    const giorniLavorativiRimanenti = giorni.filter(g => g >= giorno && g.getDay() !== 0).length || 1

    for (const emp of employees) {
      // Indisponibilità dichiarata → riposo
      if (unavailMap[emp.id]?.has(dataStr)) {
        shifts.push({ schedule_id: scheduleId, employee_id: emp.id, data: dataStr, tipo: 'riposo' })
        continue
      }

      // R5 — giorno compensativo dopo una domenica lavorata
      if (compensatorioPendente[emp.id]) {
        delete compensatorioPendente[emp.id]
        shifts.push({ schedule_id: scheduleId, employee_id: emp.id, data: dataStr, tipo: 'riposo' })
        continue
      }

      let tipo: TurnoTipo

      // R1 — Gilda e Tony: sempre mattina
      if (emp.turno_fisso === 'mattina') {
        tipo = 'mattina'
      }
      // R1/R3 — Yuri: sempre presente, mattina o full, MAI pomeriggio
      else if (emp.nome === 'Yuri') {
        const oreTarget = ORE_MENSILI_MD[emp.ore_settimanali] ?? 200
        const oreRimanenti = oreTarget - oreAssegnate[emp.id]
        const orePerGiorno = oreRimanenti / giorniLavorativiRimanenti
        tipo = orePerGiorno >= 8 ? 'full' : 'mattina'
      }
      // R2 — Alternanza Max/Romeo (gruppo AB), a settimane alterne
      // NOTA: Carlo NON fa parte dell'alternanza — viene assegnato liberamente
      // dal ramo greedy in base alle ore rimanenti (non ha turno_fisso,
      // alternanza_gruppo, né priorita_cassa 1/2, quindi cade nel ramo "else" sotto).
      else if (emp.alternanza_gruppo === 'AB') {
        const isMax = emp.nome === 'Max'
        const mattinaOra = weekIsEven ? isMax : !isMax
        tipo = mattinaOra ? 'mattina' : 'pomeriggio'
      }
      // R4 — 22h: 2 sempre mattina, 2 sempre pomeriggio (split fisso per indice)
      else if (emp.priorita_cassa === 1) {
        const idx = cassieri22.findIndex(e => e.id === emp.id)
        tipo = idx % 2 === 0 ? 'mattina' : 'pomeriggio'
      }
      // R4 — 28h: distribuiti, alternano mattina/pomeriggio a settimane alterne
      else if (emp.priorita_cassa === 2) {
        const idx = cassieri28.findIndex(e => e.id === emp.id)
        const mattinaOra = weekIsEven ? idx % 2 === 0 : idx % 2 === 1
        tipo = mattinaOra ? 'mattina' : 'pomeriggio'
      }
      // Cristina (30h) e altri non coperti dalle regole sopra: greedy su ore rimanenti
      else {
        const oreTarget = ORE_MENSILI_MD[emp.ore_settimanali] ?? 130
        const oreRimanenti = oreTarget - oreAssegnate[emp.id]
        const orePerGiorno = oreRimanenti / giorniLavorativiRimanenti
        tipo = orePerGiorno >= 5 ? (dayOfWeek % 2 === 0 ? 'mattina' : 'pomeriggio') : 'riposo'
      }

      oreAssegnate[emp.id] += ORE_TURNO_MD[tipo]
      const orario = tipo !== 'riposo' ? ORARI_TURNO_MD[tipo] : null
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

  return shifts
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
