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
// - R3 (Max/Romeo): Max lavora ogni giorno feriale a turni fissi da 5h (30h/settimana
//   esatte per costruzione). Romeo invece usa i turni standard da 6h — se lavorasse
//   tutti i 6 giorni feriali farebbe 36h/settimana, oltre il suo contratto 28h. Questo
//   ramo NON fa pacing sulle ore rimanenti (era già così prima per il gruppo AB) — va
//   rivisto se Romeo risulta sistematicamente sopra le ore contrattuali a fine mese.
// - R5 (Cristina/Stefania): "3 mattine + 3 pomeriggi a settimana" è implementato come
//   giorni fissi (Lun/Mer/Ven mattina, Mar/Gio/Sab pomeriggio) — deterministico e
//   sempre 3+3, ma non ruota, sarà sempre lo stesso pattern settimana dopo settimana.
// - R4 (22h): rotazione a coppie tramite (giorno_del_mese + indice) % 4 — garantisce
//   sempre esattamente 2 mattina + 2 pomeriggio al giorno, e varia la coppia nel tempo,
//   ma non è una vera equalizzazione stocastica del totale mensile per persona.
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

  const cassieri22 = employees.filter(e => e.priorita_cassa === 1)

  for (const giorno of giorni) {
    const dataStr = formatDate(giorno)
    const dayOfWeek = giorno.getDay() // 0=domenica, 1=lunedì ... 6=sabato
    const weekIsEven = getIsoWeek(giorno) % 2 === 0

    // ── Domenica: riposo per tutti — nessuna assegnazione automatica.
    // I turni domenicali li assegna solo Giacomo manualmente (cella o Maia).
    if (dayOfWeek === 0) {
      for (const emp of employees) {
        shifts.push({ schedule_id: scheduleId, employee_id: emp.id, data: dataStr, tipo: 'riposo' })
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

      let tipo: TurnoTipo

      // R1 — Gilda e Tony: sempre mattina, mai domenica (già escluse sopra)
      if (emp.turno_fisso === 'mattina') {
        tipo = 'mattina'
      }
      // R2 — Carlo: Mar/Gio obbligatoriamente mattina; altri giorni preferenza
      // mattina, pomeriggio solo se il ritmo ore/giorni residui lo richiede.
      else if (emp.nome === 'Carlo') {
        if (dayOfWeek === 2 || dayOfWeek === 4) {
          tipo = 'mattina'
        } else {
          const oreTarget = ORE_MENSILI_MD[emp.ore_settimanali] ?? 130
          const oreRimanenti = oreTarget - oreAssegnate[emp.id]
          const orePerGiorno = oreRimanenti / giorniLavorativiRimanenti
          if (orePerGiorno >= 6.5) tipo = 'pomeriggio'       // serve bilanciare: troppe ore rimaste
          else if (orePerGiorno >= 3) tipo = 'mattina'        // preferenza standard
          else tipo = 'riposo'
        }
      }
      // R1 — Yuri: Lun/Mer/Ven turno lungo 08-16, Mar/Gio pomeriggio corto 13-16
      // (mattina in salumeria), Sabato mattina standard 08-14. Mai pomeriggio pieno.
      else if (emp.nome === 'Yuri') {
        if (dayOfWeek === 1 || dayOfWeek === 3 || dayOfWeek === 5) tipo = 'yuri_full'
        else if (dayOfWeek === 2 || dayOfWeek === 4) tipo = 'yuri_pomeriggio'
        else tipo = 'mattina' // sabato (dayOfWeek === 6)
      }
      // R3 — Alternanza Max/Romeo (gruppo AB), a settimane alterne.
      // Max usa turni corti da 5h (mattina_corta/pomeriggio_corto), Romeo turni standard da 6h.
      else if (emp.alternanza_gruppo === 'AB') {
        const isMax = emp.nome === 'Max'
        const mattinaOra = weekIsEven ? isMax : !isMax
        if (isMax) {
          tipo = mattinaOra ? 'mattina_corta' : 'pomeriggio_corto'
        } else {
          tipo = mattinaOra ? 'mattina' : 'pomeriggio'
        }
      }
      // R4 — 22h: sempre 2 di mattina + 2 di pomeriggio, coppia a rotazione (non fissa)
      else if (emp.priorita_cassa === 1) {
        const idx = cassieri22.findIndex(e => e.id === emp.id)
        const dayIndex = giorno.getDate()
        tipo = (dayIndex + idx) % 4 < 2 ? 'mattina' : 'pomeriggio'
      }
      // R5 — Cristina (30h) e Stefania (28h): 3 mattine + 3 pomeriggi fissi a settimana
      else if (emp.priorita_cassa === 2 || emp.priorita_cassa === 3) {
        const oreTarget = ORE_MENSILI_MD[emp.ore_settimanali] ?? 130
        const oreRimanenti = oreTarget - oreAssegnate[emp.id]
        const orePerGiorno = oreRimanenti / giorniLavorativiRimanenti
        if (orePerGiorno < 3) {
          tipo = 'riposo'
        } else {
          const mattinaGiorni = [1, 3, 5] // Lun, Mer, Ven
          tipo = mattinaGiorni.includes(dayOfWeek) ? 'mattina' : 'pomeriggio'
        }
      }
      // Fallback greedy per eventuali dipendenti non coperti dalle regole sopra
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
