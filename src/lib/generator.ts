import {
  Employee, Shift, Unavailability, TurnoTipo, ORE_TURNO,
  ORE_TURNO_MD, ORARI_TURNO_MD, MD_LANCIANO_STORE_NOME,
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
// ALGORITMO MD LANCIANO — R1-R7 (domenica ESCLUSA — vedi nota sotto)
// ─────────────────────────────────────────────────────────────────────────────
//
// DOMENICA: non gestita da questo algoritmo. Ogni domenica è sempre "riposo" di
// default per tutti — i turni domenicali (domenica_lungo/domenica_corto) vengono
// assegnati SOLO manualmente da Giacomo (click sulla cella o tramite Maia), incluso
// il relativo riposo compensativo durante la settimana. Vedi system prompt di Maia
// in src/app/api/maia-chat/route.ts per le regole domenicali complete.
//
// NOTE — semplificazioni rispetto alla specifica ideale (documentate esplicitamente):
// - R6/R7 (copertura minima cassieri fascia 13-16 e chiusura 20:00, min. 3/4 persone):
//   NON verificate algoritmicamente giorno per giorno — vanno controllate a vista dopo
//   la generazione. Servirebbe un vero constraint solver per garantirle in automatico.
// - Budget ore ORA è SETTIMANALE (per settimana ISO), non più una media mensile — questo
//   fix risolve il bug per cui alcuni dipendenti (es. Angelica 22h, Romeo 28h) finivano
//   sistematicamente sopra le ore contrattuali: prima il pacing guardava la media
//   dell'intero mese residuo, quindi un dipendente poteva lavorare troppo nelle prime
//   settimane senza che l'algoritmo se ne accorgesse fino a fine mese.
// - R4 (22h) e R3/Romeo: dato che 22h e 28h non sono multipli esatti di 6h (un turno
//   standard), il rispetto rigoroso del tetto settimanale implica che quella settimana
//   la persona lavori qualche ora IN MENO del contratto invece di sforare (es. Stefania
//   28h ÷ 6h/turno = 4 giorni pieni = 24h, non 28h esatte) — è una conseguenza aritmetica
//   inevitabile con turni da 6h fissi, non un bug: non può mai sforare, può restare
//   leggermente sotto in singole settimane.
// - R5 (Cristina/Stefania): "3 mattine + 3 pomeriggi a settimana" resta su giorni fissi
//   (Lun/Mer/Ven mattina, Mar/Gio/Sab pomeriggio), ma ora si ferma quando il budget
//   settimanale è esaurito invece di aspettare la fine del mese.
// - R4 (22h): rotazione a coppie tramite (giorno_del_mese + indice) % 4 per variare chi
//   fa mattina/pomeriggio, ma ora soggetta anche al budget settimanale — quando qualcuno
//   del gruppo va in riposo per budget, la copertura "sempre 2+2" può scendere sotto 2
//   per quel giorno: è il trade-off inevitabile tra "22h contrattuali rispettate" e
//   "copertura 2+2 garantita ogni giorno", matematicamente non sempre compatibili
//   (22h ÷ 6h ≈ 3.7 giorni/settimana per persona, quindi in media non tutti e 4 presenti
//   ogni giorno). Segnalare a Giacomo se la copertura risulta insufficiente a vista.
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

  // Budget ore SETTIMANALE (non mensile) — chiave: `${employeeId}_${isoWeek}`
  const oreSettimana: Record<string, number> = {}
  const weekKey = (empId: string, week: number) => `${empId}_${week}`
  const oreSettimanaCorrente = (empId: string, week: number) => oreSettimana[weekKey(empId, week)] ?? 0
  const registraOre = (empId: string, week: number, ore: number) => {
    oreSettimana[weekKey(empId, week)] = oreSettimanaCorrente(empId, week) + ore
  }

  const cassieri22 = employees.filter(e => e.priorita_cassa === 1)

  for (const giorno of giorni) {
    const dataStr = formatDate(giorno)
    const dayOfWeek = giorno.getDay() // 0=domenica, 1=lunedì ... 6=sabato
    const settimana = getIsoWeek(giorno)
    const weekIsEven = settimana % 2 === 0

    // ── Domenica: riposo per tutti — nessuna assegnazione automatica.
    // I turni domenicali li assegna solo Giacomo manualmente (cella o Maia).
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

      const margineSettimana = emp.ore_settimanali - oreSettimanaCorrente(emp.id, settimana)

      let tipo: TurnoTipo

      // R1 — Gilda e Tony: sempre mattina, mai domenica (già escluse sopra).
      // 6h × 6 giorni = 36h/settimana = contratto esatto, nessun pacing necessario.
      if (emp.turno_fisso === 'mattina') {
        tipo = 'mattina'
      }
      // R2 — Carlo: Mar/Gio obbligatoriamente mattina; altri giorni preferenza
      // mattina, pomeriggio solo se il margine settimanale residuo lo richiede.
      else if (emp.nome === 'Carlo') {
        if (dayOfWeek === 2 || dayOfWeek === 4) {
          tipo = 'mattina'
        } else if (margineSettimana < 3) {
          tipo = 'riposo'
        } else if (margineSettimana >= 9) {
          tipo = 'pomeriggio' // molto margine rimasto: bilancia più in fretta
        } else {
          tipo = 'mattina' // preferenza standard
        }
      }
      // R1 — Yuri: Lun/Mer/Ven turno lungo 08-16, Mar/Gio pomeriggio corto 13-16
      // (mattina in salumeria), Sabato mattina standard 08-14. Mai pomeriggio pieno.
      // Fisso da regola assoluta — nessun pacing (vedi nota sopra sul mismatch 30h/36h).
      else if (emp.nome === 'Yuri') {
        if (dayOfWeek === 1 || dayOfWeek === 3 || dayOfWeek === 5) tipo = 'yuri_full'
        else if (dayOfWeek === 2 || dayOfWeek === 4) tipo = 'yuri_pomeriggio'
        else tipo = 'mattina' // sabato (dayOfWeek === 6)
      }
      // R3 — Alternanza Max/Romeo (gruppo AB), a settimane alterne.
      // Max: turni corti da 5h × 6gg = 30h/settimana = contratto esatto, nessun pacing.
      // Romeo: turni standard da 6h, CON pacing settimanale (28h contrattuali).
      else if (emp.alternanza_gruppo === 'AB') {
        const isMax = emp.nome === 'Max'
        const mattinaOra = weekIsEven ? isMax : !isMax
        if (isMax) {
          tipo = mattinaOra ? 'mattina_corta' : 'pomeriggio_corto'
        } else if (margineSettimana < 5) {
          tipo = 'riposo'
        } else {
          tipo = mattinaOra ? 'mattina' : 'pomeriggio'
        }
      }
      // R4 — 22h: 2 mattina + 2 pomeriggio quando in servizio, coppia a rotazione,
      // MA soggetto al budget settimanale di 22h (vedi nota sul trade-off di copertura).
      else if (emp.priorita_cassa === 1) {
        if (margineSettimana < 5) {
          tipo = 'riposo'
        } else {
          const idx = cassieri22.findIndex(e => e.id === emp.id)
          const dayIndex = giorno.getDate()
          tipo = (dayIndex + idx) % 4 < 2 ? 'mattina' : 'pomeriggio'
        }
      }
      // R5 — Cristina (30h) e Stefania (28h): 3 mattine + 3 pomeriggi fissi a settimana,
      // con pacing settimanale (si ferma quando il budget di quella settimana è esaurito).
      else if (emp.priorita_cassa === 2 || emp.priorita_cassa === 3) {
        if (margineSettimana < 5) {
          tipo = 'riposo'
        } else {
          const mattinaGiorni = [1, 3, 5] // Lun, Mer, Ven
          tipo = mattinaGiorni.includes(dayOfWeek) ? 'mattina' : 'pomeriggio'
        }
      }
      // Fallback greedy per eventuali dipendenti non coperti dalle regole sopra
      else {
        tipo = margineSettimana >= 5 ? (dayOfWeek % 2 === 0 ? 'mattina' : 'pomeriggio') : 'riposo'
      }

      registraOre(emp.id, settimana, ORE_TURNO_MD[tipo])
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
