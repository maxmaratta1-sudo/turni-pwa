import { Employee, Shift } from '@/types'
import { oreFromOrario } from './generator'

export interface ValidationError {
  employee_nome: string
  data: string
  motivo: string
}

/** Valida un array di turni proposti (tipicamente output di Opus) contro i vincoli
 * hard di turni_config, PRIMA di salvarli. Non tocca il DB — puro controllo in memoria
 * sull'array proposto. Ritorna la lista di violazioni (vuota se tutto ok). */
export function validateWeekShifts(
  shifts: Omit<Shift, 'id' | 'created_at'>[],
  employees: Employee[],
  config: any
): ValidationError[] {
  const errori: ValidationError[] = []
  const byId = new Map(employees.map(e => [e.id, e]))
  const findDip = (nome: string) =>
    (config?.dipendenti ?? []).find((d: any) => (d.nome ?? '').trim().toLowerCase() === nome.trim().toLowerCase())

  // ── 1. Budget settimanale esatto (esclusa domenica, sempre extra) + max_ore_giorno ──
  const oreSettimana: Record<string, number> = {}
  for (const s of shifts) {
    const emp = byId.get(s.employee_id)
    if (!emp) continue
    const nome = emp.nome.trim()
    const isDomenica = s.tipo === 'domenica_lungo' || s.tipo === 'domenica_corto'
    if (isDomenica || s.tipo === 'riposo') continue

    const ore = oreFromOrario(s.ora_inizio, s.ora_fine)
    oreSettimana[emp.id] = (oreSettimana[emp.id] ?? 0) + ore

    const dip = findDip(nome)
    const maxGiorno = typeof dip?.max_ore_giorno === 'number' ? dip.max_ore_giorno : 6
    if (ore > maxGiorno) {
      errori.push({ employee_nome: nome, data: s.data, motivo: `${ore}h superano max_ore_giorno (${maxGiorno}h)` })
    }
  }
  for (const [employeeId, ore] of Object.entries(oreSettimana)) {
    const emp = byId.get(employeeId)
    if (!emp) continue
    if (ore !== emp.ore_settimanali) {
      errori.push({
        employee_nome: emp.nome.trim(),
        data: '(settimana)',
        motivo: `totale settimanale ${ore}h invece di ${emp.ore_settimanali}h (ore_contratto)`,
      })
    }
  }

  // ── 2. Copertura chiusura (turni che finiscono alle 20:00) ─────────────────────
  const cop = config?.regole_generali?.copertura_chiusura ?? { lun_ven: 3, sabato: 4 }
  const perGiorno: Record<string, typeof shifts> = {}
  for (const s of shifts) { (perGiorno[s.data] ??= []).push(s) }
  for (const [data, dayShifts] of Object.entries(perGiorno)) {
    const dow = new Date(data + 'T00:00:00').getDay()
    if (dow === 0) continue
    const minRichiesto = dow === 6 ? cop.sabato : cop.lun_ven
    const chiusura = dayShifts.filter(s => s.ora_fine === '20:00').length
    if (chiusura < minRichiesto) {
      errori.push({ employee_nome: '(copertura)', data, motivo: `chiusura scoperta: ${chiusura}/${minRichiesto} presenti alle 20:00` })
    }
  }

  // ── 3. Fascia obbligatoria cassa (default 13:00-16:00, min. 2 cassieri) ─────────
  const fascia = config?.regole_generali?.fascia_obbligatoria_cassa
  if (fascia) {
    for (const [data, dayShifts] of Object.entries(perGiorno)) {
      const dow = new Date(data + 'T00:00:00').getDay()
      if (dow === 0) continue
      const presenti = dayShifts.filter(s => s.ora_inizio && s.ora_fine && s.ora_inizio <= fascia.inizio && s.ora_fine >= fascia.fine)
      if (presenti.length < (fascia.minimo_cassieri ?? 2)) {
        errori.push({ employee_nome: '(fascia obbligatoria)', data, motivo: `${fascia.inizio}-${fascia.fine} scoperta: ${presenti.length}/${fascia.minimo_cassieri} presenti` })
      }
    }
  }

  // ── 4. Cristina/Stefania mai lo stesso turno lo stesso giorno ───────────────────
  const cristina = employees.find(e => e.nome.trim() === 'Cristina')
  const stefania = employees.find(e => e.nome.trim() === 'Stefania')
  if (cristina && stefania) {
    for (const data of Object.keys(perGiorno)) {
      const sC = shifts.find(s => s.employee_id === cristina.id && s.data === data)
      const sS = shifts.find(s => s.employee_id === stefania.id && s.data === data)
      if (sC && sS && sC.tipo !== 'riposo' && sS.tipo !== 'riposo' && sC.tipo === sS.tipo) {
        errori.push({ employee_nome: 'Cristina/Stefania', data, motivo: `stesso turno (${sC.tipo}) lo stesso giorno — devono essere sempre opposte` })
      }
    }
  }

  return errori
}
