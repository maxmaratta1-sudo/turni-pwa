export type TurnoTipo = 'mattina' | 'pomeriggio' | 'full' | 'riposo' | 'domenica_lungo' | 'domenica_corto'

export const MD_LANCIANO_STORE_NOME = 'MD Lanciano'

export interface Store {
  id: string
  nome: string
  created_at: string
}

export type Ruolo = 'cassiere' | 'non_cassiere'
export type TurnoFisso = 'mattina' | 'pomeriggio' | null

export interface Employee {
  id: string
  store_id: string
  nome: string
  ore_settimanali: 20 | 22 | 28 | 30 | 35 | 36 | 40 | 46
  token: string
  attivo: boolean
  // ── Campi MD Lanciano (opzionali — undefined per Stroili) ──
  ruolo?: Ruolo
  priorita_cassa?: number
  turno_fisso?: TurnoFisso
  alternanza_gruppo?: string | null
}

export interface Schedule {
  id: string
  store_id: string
  mese: number
  anno: number
  stato: 'bozza' | 'pubblicato'
}

export interface Unavailability {
  id: string
  employee_id: string
  schedule_id: string
  data: string
  motivo?: string
}

export interface Shift {
  id: string
  schedule_id: string
  employee_id: string
  data: string
  tipo: TurnoTipo
  ora_inizio?: string
  ora_fine?: string
}

// Ore per tipo turno — Stroili Oasi Lanciano (store di default)
export const ORE_TURNO: Record<TurnoTipo, number> = {
  mattina: 5,    // 09:00-14:00
  pomeriggio: 6, // 14:00-20:00
  full: 9,       // 09:00-20:00
  riposo: 0,
  domenica_lungo: 0, // non usato da Stroili
  domenica_corto: 0, // non usato da Stroili
}

export const ORARI_TURNO: Record<TurnoTipo, { inizio: string; fine: string } | null> = {
  mattina:    { inizio: '09:00', fine: '14:00' },
  pomeriggio: { inizio: '14:00', fine: '20:00' },
  full:       { inizio: '09:00', fine: '20:00' },
  riposo: null,
  domenica_lungo: null,
  domenica_corto: null,
}

// ── MD Lanciano — orari e ore propri (store-specific, non toccano Stroili) ──
export const ORE_TURNO_MD: Record<TurnoTipo, number> = {
  mattina: 6,          // 08:00-14:00
  pomeriggio: 6,       // 14:00-20:00
  full: 9,             // 08:00-20:00 (11.5h, 9h effettive con pausa)
  riposo: 0,
  domenica_lungo: 5,   // 08:00-13:00
  domenica_corto: 3,   // 10:00-13:00
}

export const ORARI_TURNO_MD: Record<TurnoTipo, { inizio: string; fine: string } | null> = {
  mattina:        { inizio: '08:00', fine: '14:00' },
  pomeriggio:     { inizio: '14:00', fine: '20:00' },
  full:           { inizio: '08:00', fine: '20:00' },
  riposo: null,
  domenica_lungo: { inizio: '08:00', fine: '13:00' },
  domenica_corto: { inizio: '10:00', fine: '13:00' },
}

// Ore mensili target per contratto MD Lanciano (R6)
export const ORE_MENSILI_MD: Record<number, number> = {
  46: 200,
  36: 156,
  35: 152,
  30: 130,
  28: 121,
  22: 95,
}
