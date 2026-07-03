export type TurnoTipo = 'mattina' | 'pomeriggio' | 'full' | 'riposo'

export interface Store {
  id: string
  nome: string
  created_at: string
}

export interface Employee {
  id: string
  store_id: string
  nome: string
  ore_settimanali: 20 | 30 | 40
  token: string
  attivo: boolean
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

// Ore per tipo turno
export const ORE_TURNO: Record<TurnoTipo, number> = {
  mattina: 5,    // 09:00-14:00
  pomeriggio: 6, // 14:00-20:00
  full: 9,       // 09:00-20:00
  riposo: 0
}

export const ORARI_TURNO: Record<TurnoTipo, { inizio: string; fine: string } | null> = {
  mattina:    { inizio: '09:00', fine: '14:00' },
  pomeriggio: { inizio: '14:00', fine: '20:00' },
  full:       { inizio: '09:00', fine: '20:00' },
  riposo: null
}
