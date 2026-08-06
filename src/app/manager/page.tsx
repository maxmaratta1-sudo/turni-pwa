'use client'
import { useState, useEffect, useRef, Fragment } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { Employee, Schedule, Shift, TurnoTipo, MD_LANCIANO_STORE_NOME, ORARI_TURNO, ORARI_TURNO_MD, FerieSaldo } from '@/types'
import MaiaChatBubble from '@/components/MaiaChatBubble'
import { oreFromOrario } from '@/lib/generator'

const MESI = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno',
               'Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre']

// Ordine fisso dipendenti per MD Lanciano (non alfabetico) — Stroili resta alfabetico.
const ORDINE_MD = [
  'Angelica', 'Damiana', 'Elisa', 'Marilena',
  'Max', 'Romeo', 'Stefania', 'Cristina',
  'Yuri', 'Tony', 'Gilda',
]

function sortEmployees(emps: Employee[], isMD: boolean): Employee[] {
  if (!isMD) return [...emps].sort((a, b) => a.nome.localeCompare(b.nome))
  return [...emps].sort((a, b) => {
    const ia = ORDINE_MD.indexOf(a.nome)
    const ib = ORDINE_MD.indexOf(b.nome)
    if (ia === -1 && ib === -1) return a.nome.localeCompare(b.nome)
    if (ia === -1) return 1  // dipendenti non in lista vanno in fondo
    if (ib === -1) return -1
    return ia - ib
  })
}
const TURNO_CYCLE: Record<TurnoTipo, TurnoTipo> = {
  mattina: 'pomeriggio', pomeriggio: 'full', full: 'riposo', riposo: 'mattina',
  domenica_lungo: 'domenica_lungo', domenica_corto: 'domenica_corto',
  yuri_full: 'yuri_full', yuri_pomeriggio: 'yuri_pomeriggio',
  mattina_corta: 'pomeriggio_corto', pomeriggio_corto: 'mattina_corta',
  // Turni brevi — casi eccezionali, non fanno parte del ciclo standard (si assegnano solo dal popup/Maia).
  turno_breve_11_14: 'turno_breve_11_14', turno_breve_12_15: 'turno_breve_12_15',
  turno_breve_13_16: 'turno_breve_13_16', turno_breve_17_20: 'turno_breve_17_20',
}
const TURNO_LABEL: Record<string, string> = {
  mattina: 'M', pomeriggio: 'Pm', full: 'F', riposo: '—', domenica_lungo: 'DL', domenica_corto: 'DC',
  yuri_full: 'YF', yuri_pomeriggio: 'Y', mattina_corta: 'M5', pomeriggio_corto: 'P5',
  turno_breve_11_14: '11/14', turno_breve_12_15: '12/15', turno_breve_13_16: '13/16', turno_breve_17_20: '17/20',
}
const TURNO_COLOR: Record<string, string> = {
  mattina: 'bg-blue-100 text-blue-800',
  mattina_corta: 'bg-cyan-100 text-cyan-800',   // Max mattina — distinto
  pomeriggio: 'bg-orange-100 text-orange-800',
  pomeriggio_corto: 'bg-orange-100 text-orange-800', // Max pomeriggio — STESSO colore pomeriggio
  full: 'bg-green-100 text-green-800',
  yuri_full: 'bg-indigo-200 text-indigo-900',
  yuri_pomeriggio: 'bg-purple-100 text-purple-800',
  domenica_lungo: 'bg-purple-200 text-purple-900',
  domenica_corto: 'bg-purple-100 text-purple-800',
  riposo: 'bg-gray-100 text-gray-400',
  // Stesso colore rosa per tutti i turni brevi — riconoscibili a colpo d'occhio come eccezione.
  turno_breve_11_14: 'bg-pink-100 text-pink-800',
  turno_breve_12_15: 'bg-pink-100 text-pink-800',
  turno_breve_13_16: 'bg-pink-100 text-pink-800',
  turno_breve_17_20: 'bg-pink-100 text-pink-800',
}
// Ore lavorate per tipo turno — usato per la colonna TOT settimanale (solo MD).
const ORE_PER_TURNO: Record<string, number> = {
  mattina: 6, pomeriggio: 6, full: 9,
  mattina_corta: 5, pomeriggio_corto: 5,
  yuri_full: 6, yuri_pomeriggio: 3,
  domenica_lungo: 5, domenica_corto: 3,
  riposo: 0,
  turno_breve_11_14: 3, turno_breve_12_15: 3, turno_breve_13_16: 3, turno_breve_17_20: 3,
}

const ASSENZA_LABEL: Record<string, string> = {
  P: 'Permesso', F: 'Ferie', R: 'Recupero', M: 'Malattia', MT: 'Maternità',
}

const ASSENZA_COLOR: Record<string, string> = {
  F: 'bg-yellow-100 text-yellow-800',
  P: 'bg-orange-100 text-orange-800',
  R: 'bg-blue-100 text-blue-800',
  M: 'bg-red-100 text-red-800',
  MT: 'bg-pink-100 text-pink-800',
}

// Orari reali MD Lanciano — mostrati in cella invece delle lettere, SOLO per MD.
// Stroili conserva le lettere (i suoi orari reali sono 9-14/14-20, diversi da MD).
const TURNO_ORARIO_MD: Record<string, string> = {
  mattina: '8/14', pomeriggio: '14/20', full: '8/20',
  mattina_corta: '8/13', pomeriggio_corto: '14/19',
  yuri_full: '8/16', yuri_pomeriggio: '13/16',
  domenica_lungo: '8/13', domenica_corto: '10/13',
  riposo: '—',
  turno_breve_11_14: '11/14', turno_breve_12_15: '12/15', turno_breve_13_16: '13/16', turno_breve_17_20: '17/20',
}

function formatOraShort(time?: string | null): string {
  if (!time) return ''
  return time.split(':')[0]
}

/** Mostra l'orario REALE del turno (da ora_inizio/ora_fine, ore intere variabili) —
 * fallback al lookup fisso solo se i tempi non sono stati salvati (righe legacy). */
function getTurnoDisplay(tipo: string, isMD: boolean, shift?: { ora_inizio?: string | null; ora_fine?: string | null }): string {
  if (isMD) {
    if (tipo !== 'riposo' && shift?.ora_inizio && shift?.ora_fine) {
      return `${formatOraShort(shift.ora_inizio)}/${formatOraShort(shift.ora_fine)}`
    }
    return TURNO_ORARIO_MD[tipo] ?? TURNO_LABEL[tipo] ?? tipo
  }
  return TURNO_LABEL[tipo] ?? tipo
}

/** Ore effettive lavorate — calcolate dagli orari reali del turno, non da un lookup fisso,
 * perché con la distribuzione a ore intere le ore variano giorno per giorno. */
function getOreDisplay(tipo: string, shift?: { ora_inizio?: string | null; ora_fine?: string | null }): number {
  if (tipo === 'riposo') return 0
  const fromTimes = oreFromOrario(shift?.ora_inizio, shift?.ora_fine)
  return fromTimes > 0 ? fromTimes : (ORE_PER_TURNO[tipo] ?? 0)
}

/** Prossimo turno nel ciclo di click — comportamento diverso per MD Lanciano (turni fissi, domenica attiva). */
function nextTurno(current: TurnoTipo, emp: Employee, isDomenica: boolean, isMD: boolean): TurnoTipo {
  if (!isMD) return TURNO_CYCLE[current] // Stroili — invariato

  if (isDomenica) {
    // Gilda e Tony: escluse definitivamente dai turni domenicali — click bloccato su riposo
    if (emp.turno_fisso === 'mattina') return 'riposo'
    const cycle: Partial<Record<TurnoTipo, TurnoTipo>> = {
      riposo: 'domenica_lungo', domenica_lungo: 'domenica_corto', domenica_corto: 'riposo',
    }
    return cycle[current] ?? 'domenica_lungo'
  }

  // Gilda/Tony: turno fisso mattina, il click non li sposta mai in pomeriggio
  if (emp.turno_fisso === 'mattina') return 'mattina'

  // R9 — le regole/turni speciali (Yuri, Max) sono override automatici, ma un click
  // manuale di Giacomo può sempre spostare la cella sul ciclo turni standard.
  const cycle: Partial<Record<TurnoTipo, TurnoTipo>> = {
    mattina: 'pomeriggio', pomeriggio: 'full', full: 'riposo', riposo: 'mattina',
    domenica_lungo: 'mattina', domenica_corto: 'mattina',
    yuri_full: 'pomeriggio', yuri_pomeriggio: 'pomeriggio',
    mattina_corta: 'pomeriggio_corto', pomeriggio_corto: 'riposo',
  }
  return cycle[current] ?? 'mattina'
}

interface Unavailability {
  id: string
  employee_id: string
  schedule_id: string
  data: string
  motivo: string | null
  tipo_assenza?: string | null
  inserito_da?: string | null
  ore_parziali?: number | null
  created_at?: string
}

export default function ManagerPage() {
  const router = useRouter()
  const [storeId, setStoreId] = useState<string | null>(null)
  const [storeNome, setStoreNome] = useState('')
  const [mese, setMese] = useState(1)
  const [anno, setAnno] = useState(2026)
  const [employees, setEmployees] = useState<Employee[]>([])
  const [schedule, setSchedule] = useState<Schedule | null>(null)
  const [shifts, setShifts] = useState<Shift[]>([])
  const [unavailabilities, setUnavailabilities] = useState<Unavailability[]>([])
  const [loading, setLoading] = useState(false)
  const [newEmp, setNewEmp] = useState({ nome: '', ore_settimanali: 20 })
  const [showAddForm, setShowAddForm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedToken, setCopiedToken] = useState<string | null>(null)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [cestino, setCestino] = useState<Employee[]>([])
  const [showCestino, setShowCestino] = useState(false)
  const [dettaglioEmp, setDettaglioEmp] = useState<Employee | null>(null)
  const [modalSelected, setModalSelected] = useState<Set<string>>(new Set())
  const [modalMotivo, setModalMotivo] = useState('')
  const [modalSaved, setModalSaved] = useState(false)
  const [modalSaving, setModalSaving] = useState(false)
  const [modalTipoAssenza, setModalTipoAssenza] = useState('P')
  const [modalOreParziali, setModalOreParziali] = useState<string>('')
  const [festiviMap, setFestiviMap] = useState<Record<string, string>>({})
  const [storicoAssenze, setStoricoAssenze] = useState<Unavailability[]>([])
  const [loadingStorico, setLoadingStorico] = useState(false)
  const [ferieSaldi, setFerieSaldi] = useState<Record<string, FerieSaldo>>({})
  const [popupCell, setPopupCell] = useState<{ empId: string; data: string; x: number; y: number } | null>(null)
  const [showChiusure, setShowChiusure] = useState(false)
  const [settimanaChiusure, setSettimanaChiusure] = useState(0)
  const [showMezzogiorno, setShowMezzogiorno] = useState(false)
  const [settimanaMezzogiorno, setSettimanaMezzogiorno] = useState(0)
  const [settimanaSelezionata, setSettimanaSelezionata] = useState<number | ''>('')

  const giorni = getDays(anno, mese)
  // Regola assoluta: i giorni del mese vanno sempre in ordine cronologico 1→31,
  // mai riordinati per settimana ISO (la colonna TOT si inserisce dopo ogni domenica,
  // ma l'ordine dei giorni non cambia mai).
  const giorniOrdinati = giorni
  const offsetLunedi = getOffsetLunedi(anno, mese)
  const isMD = storeNome === MD_LANCIANO_STORE_NOME
  const settimaneMese = getSettimaneLunDom(giorni, mese)
  const settimanaAttiva = settimanaSelezionata !== '' ? settimaneMese[settimanaSelezionata] : null

  useEffect(() => {
    const id = localStorage.getItem('turni_store_id')
    if (!id) { router.replace('/login'); return }
    setStoreId(id)
    setStoreNome(localStorage.getItem('turni_store_nome') ?? '')
    const today = new Date()
    setMese(today.getMonth() + 1)
    setAnno(today.getFullYear())
  }, [])

  useEffect(() => { if (storeId) loadData() }, [mese, anno, storeId])

  // Ricarica i turni quando Maia ne modifica uno via tool calling
  useEffect(() => {
    window.addEventListener('maiaShiftUpdated', loadData)
    return () => window.removeEventListener('maiaShiftUpdated', loadData)
  }, [loadData])

  // Seed del modal indisponibilità quando si apre per un dipendente
  useEffect(() => {
    if (!dettaglioEmp) return
    const dates = unavailabilities.filter(u => u.employee_id === dettaglioEmp.id).map(u => u.data)
    setModalSelected(new Set(dates))
    const firstMotivo = unavailabilities.find(u => u.employee_id === dettaglioEmp.id)?.motivo
    setModalMotivo(firstMotivo ?? '')
    const firstRecord = unavailabilities.find(u => u.employee_id === dettaglioEmp.id)
    setModalTipoAssenza(firstRecord?.tipo_assenza ?? 'P')
    setModalOreParziali(firstRecord?.ore_parziali ? String(firstRecord.ore_parziali) : '')
    setModalSaved(false)

    // Storico assenze completo (tutti i mesi, non solo lo schedule corrente)
    setLoadingStorico(true)
    supabase.from('unavailabilities')
      .select('*')
      .eq('employee_id', dettaglioEmp.id)
      .order('data', { ascending: false })
      .limit(50)
      .then(({ data }) => {
        setStoricoAssenze(data || [])
        setLoadingStorico(false)
      })
  }, [dettaglioEmp])

  async function loadData() {
    setLoading(true)
    setError(null)
    try {
      const { data: inCestino } = await supabase.from('employees')
        .select('*').eq('store_id', storeId!).eq('attivo', false).order('nome')
      setCestino(inCestino || [])

      const { data: emps, error: empErr } = await supabase.from('employees')
        .select('*').eq('store_id', storeId!).eq('attivo', true).order('nome')
      if (empErr) { setError(`employees: ${empErr.message}`); setLoading(false); return }
      setEmployees(sortEmployees(emps || [], isMD))

      if (isMD) {
        const { data: festiviData } = await supabase.from('turni_festivi')
          .select('data, nome').eq('store_id', storeId!)
        setFestiviMap(Object.fromEntries((festiviData || []).map((f: any) => [f.data, f.nome])))
      }

      if (isMD && emps && emps.length > 0) {
        const { data: saldi } = await supabase.from('ferie_saldo')
          .select('*').in('employee_id', emps.map(e => e.id)).eq('anno', anno)
        const map: Record<string, FerieSaldo> = {}
        for (const s of saldi || []) map[s.employee_id] = s
        setFerieSaldi(map)
      }

      const { data: sched, error: schedErr } = await supabase.from('schedules')
        .select('*').eq('store_id', storeId!).eq('mese', mese).eq('anno', anno).maybeSingle()
      if (schedErr) { setError(`schedules: ${schedErr.message}`); setLoading(false); return }
      setSchedule(sched)

      if (sched) {
        const { data: sh } = await supabase.from('shifts').select('*').eq('schedule_id', sched.id)
        setShifts(sh || [])

        const { data: unav } = await supabase.from('unavailabilities')
          .select('*').eq('schedule_id', sched.id)
        setUnavailabilities(unav || [])
      } else {
        setShifts([])
        setUnavailabilities([])
      }
    } catch (e: any) {
      setError(`Errore: ${e?.message ?? String(e)}`)
    }
    setLoading(false)
  }

  async function createSchedule() {
    const { data } = await supabase.from('schedules')
      .insert({ store_id: storeId!, mese, anno, stato: 'bozza' }).select().single()
    setSchedule(data)
  }

  async function generateTurni() {
    if (!schedule) return
    setLoading(true)
    await fetch('/api/shifts/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule_id: schedule.id })
    })
    await loadData()
  }

  async function generaSettimana() {
    if (!schedule || !settimanaAttiva) return
    const giorniLunSab = settimanaAttiva.giorni.filter(g => !g.domenica)
    const weekStart = giorniLunSab[0]?.data
    const weekEnd = giorniLunSab[giorniLunSab.length - 1]?.data
    if (!weekStart || !weekEnd) return

    setLoading(true)
    const res = await fetch('/api/shifts/generate-week', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule_id: schedule.id, week_start: weekStart, week_end: weekEnd })
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(`Errore generazione settimana: ${data.error ?? res.statusText}`)
    } else {
      // Esce dalla modalità "editing settimana" dopo una generazione riuscita — il bordo
      // blu segue sempre settimanaSelezionata, quindi resettandola sparisce di conseguenza
      // (in caso di errore resta selezionata, per permettere di vedere cosa è fallito/riprovare).
      setSettimanaSelezionata('')
    }
    await loadData()
    setLoading(false)
  }

  async function resetSettimana() {
    if (!schedule || !settimanaAttiva) return
    const inizio = settimanaAttiva.giorni[0]?.data
    const fine = settimanaAttiva.giorni[settimanaAttiva.giorni.length - 1]?.data
    if (!inizio || !fine) return
    if (!window.confirm(`Cancellare turni e permessi della settimana ${settimanaAttiva.label}?`)) return

    setLoading(true)
    await supabase.from('shifts').delete().eq('schedule_id', schedule.id).gte('data', inizio).lte('data', fine)
    await supabase.from('unavailabilities').delete().eq('schedule_id', schedule.id).gte('data', inizio).lte('data', fine)
    await loadData()
    setLoading(false)
  }

  function controllaTurni() {
    const settimane = getSettimaneLunDom(giorni, mese)

    const riepilogoOre = employees.map(emp => {
      const orePerSettimana = settimane.map((sett, i) => {
        const ore = sett.giorni.reduce((sum, g) => sum + oreLavorateGiorno(emp.id, g.data), 0)
        return `Sett${i + 1}: ${ore}h`
      })
      return `- ${emp.nome} (contratto ${emp.ore_settimanali}h): ${orePerSettimana.join(', ')}`
    }).join('\n')

    const messaggioControllo = `
Analizza il piano turni di ${MESI[mese - 1]} ${anno} usando questi dati REALI:

ORE SETTIMANALI REALI:
${riepilogoOre}

Controlla e rispondi SOLO con questo formato, in italiano semplice:

✅ o ❌ ORE SETTIMANALI:
Per ogni dipendente con ore in eccesso rispetto al contratto scrivi:
"❌ [Nome]: settimana [N] ha [X]h invece di [Y]h contratto"

✅ o ❌ FASCIA 13-16:
Segnala solo i giorni con problemi di copertura.

✅ o ⚠️ o ❌ CHIUSURA 20:00:
Segnala solo i giorni con meno di 3 persone (4 il sabato).

✅ o ❌ REGOLE FISSE:
Segnala solo le violazioni trovate.

Sii CONCISO — niente tabelle, niente ricostruzioni. Solo i problemi trovati.
`
    window.dispatchEvent(new CustomEvent('maiaAutoMessage', { detail: { message: messaggioControllo } }))
  }

  function lavoraSuSettimana() {
    if (!settimanaAttiva) return
    const giorniFeriali = settimanaAttiva.giorni.filter(g => !g.domenica)
    const domeniche = settimanaAttiva.giorni.filter(g => g.domenica)

    const situazione = employees.map(emp => {
      const turniSett = giorniFeriali
        .map(g => ({ g, shift: getShift(emp.id, g.data) }))
        .filter(({ shift }) => shift && shift.tipo !== 'riposo')
      const oreTot = giorniFeriali.reduce((sum, g) => sum + oreLavorateGiorno(emp.id, g.data), 0)
      const dettaglio = turniSett
        .map(({ g, shift }) => `${g.giorno} ${g.num}: ${getTurnoDisplay(shift!.tipo, isMD, shift!)}`)
        .join(', ')
      return `- ${emp.nome} (${emp.ore_settimanali}h contratto): ${oreTot}h assegnate${dettaglio ? ' — ' + dettaglio : ''}`
    }).join('\n')

    const domenicheTesto = domeniche.map(g => {
      const lavoranti = employees
        .map(emp => ({ emp, shift: getShift(emp.id, g.data) }))
        .filter(({ shift }) => shift && shift.tipo !== 'riposo')
      const elenco = lavoranti.map(({ emp, shift }) => `${emp.nome} (${getTurnoDisplay(shift!.tipo, isMD, shift!)})`).join(', ')
      return `- ${g.num} ${MESI[mese - 1]}: ${elenco || 'nessuno assegnato'}`
    }).join('\n')

    const primo = settimanaAttiva.giorni[0]
    const ultimo = settimanaAttiva.giorni[settimanaAttiva.giorni.length - 1]

    const contestoSettimana = `
Stiamo lavorando sulla settimana ${primo.giorno} ${primo.num} — ${ultimo.giorno} ${ultimo.num} ${MESI[mese - 1]}.

SITUAZIONE ATTUALE QUESTA SETTIMANA:
${situazione}

DOMENICHE QUESTA SETTIMANA:
${domenicheTesto || 'Nessuna domenica in questa settimana.'}

Puoi:
1. Assegnare/modificare turni di questa settimana
2. Assegnare domeniche e bilanciare automaticamente
3. Controllare la copertura chiusura 20:00
4. Verificare che le ore settimanali siano corrette per tutti
`
    window.dispatchEvent(new CustomEvent('maiaAutoMessage', { detail: { message: contestoSettimana } }))
  }

  async function pubblicaTurni() {
    if (!schedule) return
    await supabase.from('schedules').update({ stato: 'pubblicato' }).eq('id', schedule.id)
    setSchedule({ ...schedule, stato: 'pubblicato' })
  }

  async function resetMese() {
    if (!schedule) return
    const nomeMese = MESI[mese - 1]
    if (!window.confirm(`Sei sicuro? Verranno cancellati TUTTI i turni E tutti i permessi di ${nomeMese} ${anno}.`)) return
    await supabase.from('shifts').delete().eq('schedule_id', schedule.id)
    await supabase.from('unavailabilities').delete().eq('schedule_id', schedule.id)
    window.location.reload()
  }

  async function addEmployee() {
    if (!newEmp.nome.trim()) return
    await fetch('/api/employees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...newEmp, store_id: storeId! })
    })
    setNewEmp({ nome: '', ore_settimanali: 20 })
    setShowAddForm(false)
    loadData()
  }

  function getShift(empId: string, data: string) {
    return shifts.find(s => s.employee_id === empId && s.data === data)
  }

  async function cancellaEmployee(emp: Employee) {
    await supabase.from('employees').update({ attivo: false }).eq('id', emp.id)
    setEmployees(prev => prev.filter(e => e.id !== emp.id))
    setCestino(prev => [...prev, emp])
  }

  async function ripristinaEmployee(emp: Employee) {
    await supabase.from('employees').update({ attivo: true }).eq('id', emp.id)
    setCestino(prev => prev.filter(e => e.id !== emp.id))
    setEmployees(prev => sortEmployees([...prev, emp], isMD))
  }

  async function svuotaCestino() {
    for (const emp of cestino) {
      await supabase.from('shifts').delete().eq('employee_id', emp.id)
      await supabase.from('unavailabilities').delete().eq('employee_id', emp.id)
      await supabase.from('employees').delete().eq('id', emp.id)
    }
    setCestino([])
    setShowCestino(false)
  }

  function logout() {
    localStorage.removeItem('turni_store_id')
    localStorage.removeItem('turni_store_nome')
    localStorage.removeItem('turni_email')
    router.replace('/login')
  }

  function copyLink(emp: Employee) {
    const schedId = schedule?.id ?? ''
    const url = `https://turni-pwa-v2.vercel.app/dipendente/${emp.token}?schedule_id=${schedId}`
    navigator.clipboard.writeText(url)
    setCopiedToken(emp.token)
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    copyTimerRef.current = setTimeout(() => setCopiedToken(null), 2000)
  }

  async function exportPDF(giorniDaEsportare: typeof giorni = giorni, subtitle?: string) {
    const { jsPDF } = await import('jspdf')
    const { autoTable } = await import('jspdf-autotable')
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })

    const nomeMese = MESI[mese - 1]
    doc.setFontSize(14)
    doc.text(`Turni ${nomeMese} ${anno}${subtitle ? ` — ${subtitle}` : ''} — ${storeNome || 'Negozio'}`, 14, 14)

    const headRow: string[] = ['Dipendente']
    giorniDaEsportare.forEach(g => {
      headRow.push(`${g.num}\n${g.giorno}`)
      if (isMD && g.domenica) headRow.push('TOT')
    })
    const head = [headRow]

    const body = employees.map(emp => {
      const row: string[] = [emp.nome]
      giorniDaEsportare.forEach(g => {
        if (isMD && festiviMap[g.data]) {
          row.push('FEST')
        } else if (hasUnavailability(emp.id, g.data)) {
          row.push(getAssenzaCode(emp.id, g.data))
        } else {
          const shift = getShift(emp.id, g.data)
          row.push(getTurnoDisplay(shift?.tipo || 'riposo', isMD, shift))
        }
        if (isMD && g.domenica) {
          row.push(`${totSettimana(emp.id, g.data)}h`)
        }
      })
      return row
    })

    autoTable(doc, {
      head,
      body,
      startY: 20,
      styles: { fontSize: 7, cellPadding: 2, halign: 'center' },
      columnStyles: { 0: { halign: 'left', cellWidth: 30 } },
      headStyles: { fillColor: [99, 102, 241], fontSize: 7 },
      didParseCell: (data) => {
        if (data.section === 'body' && data.column.index > 0) {
          const val = data.cell.raw as string
          // Festivo — priorità massima, prevale su assenze/turni (viola, come la cella in tabella).
          if (val === 'FEST') { data.cell.styles.fillColor = [237, 233, 254]; return }
          // Assenze — sempre lettera, indipendentemente da MD/Stroili
          if (['P', 'F', 'R', 'MT'].includes(val)) { data.cell.styles.fillColor = [254, 243, 199]; return }
          // 'M' è ambiguo: assenza "Malattia" per MD, ma turno "Mattina" per Stroili
          // (che mostra ancora lettere in cella) — per MD coloriamo come assenza (rosso).
          if (val === 'M' && isMD) { data.cell.styles.fillColor = [254, 226, 226]; return }

          // Colonna TOT (es. "22h") — verde/rosso in base allo scarto dal contratto settimanale
          const totMatch = isMD ? val.match(/^(\d+)h$/) : null
          if (totMatch) {
            const tot = parseInt(totMatch[1], 10)
            const emp = employees[data.row.index]
            if (emp) {
              const diff = Math.abs(tot - emp.ore_settimanali)
              data.cell.styles.fillColor = diff <= 1 ? [220, 252, 231] : [254, 226, 226]
            }
            return
          }

          // Turni — MD mostra orari, Stroili mostra lettere: due mappe di colore separate
          const colorMD: Record<string, [number, number, number]> = {
            '8/14': [219, 234, 254],   // mattina
            '14/20': [254, 237, 213],  // pomeriggio
            '8/20': [220, 252, 231],   // full
            '—': [243, 244, 246],      // riposo
            '8/13': [237, 233, 254],   // domenica_lungo E mattina_corta (Max) condividono l'orario
            '10/13': [237, 233, 254],  // domenica_corto
            '8/16': [191, 219, 254],   // yuri_full
            '13/16': [191, 219, 254],  // yuri_pomeriggio
            '14/19': [254, 237, 213],  // pomeriggio_corto (Max) — stesso colore di pomeriggio
            '11/14': [252, 231, 243],  // turno_breve_11_14
            '12/15': [252, 231, 243],  // turno_breve_12_15
            '17/20': [252, 231, 243],  // turno_breve_17_20
          }
          const colorStroili: Record<string, [number, number, number]> = {
            M: [219, 234, 254], Pm: [254, 237, 213], F: [220, 252, 231], '—': [243, 244, 246],
            DL: [237, 233, 254], DC: [237, 233, 254], YF: [191, 219, 254], Y: [191, 219, 254],
            M5: [207, 250, 254], P5: [254, 237, 213],
          }
          const color = (isMD ? colorMD : colorStroili)[val]
          if (color) data.cell.styles.fillColor = color
        }
      }
    })

    const suffix = subtitle ? `-${subtitle.toLowerCase().replace(/\s+/g, '')}` : ''
    doc.save(`turni-${nomeMese.toLowerCase()}-${anno}${suffix}.pdf`)
  }

  async function exportPDFSettimana() {
    const settimane = getSettimaneLunDom(giorni, mese)
    if (settimane.length === 0) { alert('Nessuna settimana disponibile per questo mese.'); return }
    const elenco = settimane.map((s, i) => `${i + 1}: ${s.label}`).join('\n')
    const input = window.prompt(`Quale settimana vuoi esportare?\n${elenco}`)
    const idx = parseInt(input ?? '', 10)
    if (!idx || idx < 1 || idx > settimane.length) return
    const settimana = settimane[idx - 1]
    await exportPDF(settimana.giorni, `Settimana ${idx}`)
  }

  function hasUnavailability(empId: string, data: string) {
    return unavailabilities.some(u => u.employee_id === empId && u.data === data)
  }

  // Tipo di assenza — colonna reale `tipo_assenza` (default 'P').
  // NOTA IMPORTANTE: 'F' (Ferie) e 'M' (Malattia) letteralmente richiesti, ma collidono
  // visivamente con 'F'=turno "full" e 'M'=turno "Mattina" nella legenda/tabella di
  // Stroili (che mostra ancora lettere per i turni, non orari). Per MD non c'è ambiguità
  // — le celle turno mostrano orari, non lettere. Segnalato, non bloccante.
  const ASSENZA_CYCLE = ['P', 'F', 'R', 'M', 'MT'] as const

  function getAssenzaCode(empId: string, data: string): string {
    const u = unavailabilities.find(x => x.employee_id === empId && x.data === data)
    return u?.tipo_assenza ?? 'P'
  }

  async function cycleAssenza(empId: string, data: string) {
    const u = unavailabilities.find(x => x.employee_id === empId && x.data === data)
    if (!u) return
    const current = getAssenzaCode(empId, data)
    const idx = ASSENZA_CYCLE.indexOf(current as typeof ASSENZA_CYCLE[number])
    const next = ASSENZA_CYCLE[(idx + 1) % ASSENZA_CYCLE.length]
    await supabase.from('unavailabilities').update({ tipo_assenza: next }).eq('id', u.id)
    setUnavailabilities(prev => prev.map(x => x.id === u.id ? { ...x, tipo_assenza: next } : x))
  }

  // ── Colonna TOT settimanale (solo MD) ────────────────────────────────────
  // La colonna TOT va inserita dopo OGNI domenica reale (g.domenica), non dopo
  // giorni fissi 7/14/21/28 — un mese non inizia sempre di lunedì, quindi quei
  // numeri fissi disallineavano il raggruppamento rispetto alle settimane ISO
  // usate dall'algoritmo in generator.ts (che è invece corretto).

  function oreLavorateGiorno(empId: string, data: string): number {
    const u = unavailabilities.find(x => x.employee_id === empId && x.data === data)
    // Permesso a ore: il turno è accorciato, non azzerato — conta le ore effettivamente lavorate.
    if (u && !u.ore_parziali) return 0 // assenza a giornata intera = 0h lavorate
    const shift = getShift(empId, data)
    return getOreDisplay(shift?.tipo ?? 'riposo', shift)
  }

  /** Somma le ore lavorate nei (fino a) 7 giorni che terminano con la domenica `sundayData`. */
  function totSettimana(empId: string, sundayData: string): number {
    const sunday = new Date(sundayData + 'T00:00:00')
    const start = new Date(sunday)
    start.setDate(start.getDate() - 6)
    return giorni
      .filter(g => {
        const d = new Date(g.data + 'T00:00:00')
        return d >= start && d <= sunday
      })
      .reduce((sum, g) => sum + oreLavorateGiorno(empId, g.data), 0)
  }

  /** Stima quante ore avrebbe lavorato `emp` in un giorno festivo se non lo fosse stato —
   * cerca lo stesso giorno della settimana (dow) in un'altra data dello stesso mese, non
   * festiva e senza assenza, con un turno effettivamente assegnato, e usa quelle ore come
   * riferimento (i pattern sono fissi per giorno della settimana per quasi tutti i
   * dipendenti MD, quindi è un valore esatto nella maggior parte dei casi). Fallback:
   * media (ore_contratto / 6) se non trova nessun giorno di confronto. */
  function oreAttesePerGiornoFestivo(emp: Employee, dataFestivo: string): number {
    const dow = new Date(dataFestivo + 'T00:00:00').getDay()
    for (const g of giorni) {
      if (g.data === dataFestivo) continue
      const d = new Date(g.data + 'T00:00:00')
      if (d.getDay() !== dow) continue
      if (festiviMap[g.data]) continue
      if (hasUnavailability(emp.id, g.data)) continue
      const shift = getShift(emp.id, g.data)
      const ore = getOreDisplay(shift?.tipo ?? 'riposo', shift)
      if (ore > 0) return ore
    }
    return emp.ore_settimanali / 6
  }

  /** Target ore settimanale per il colore del TOT — ridotto esattamente delle ore che
   * `emp` avrebbe lavorato nei festivi di questa settimana (come la domenica, non deve
   * mai abbassare artificialmente il contratto atteso). Eccezione: per Carlo, un festivo
   * Lun-Ven NON riduce il target perché il generatore ridistribuisce già le sue ore sui
   * giorni feriali rimanenti (vedi distribuisciOreConFestivi in generator.ts) — ma un
   * festivo di SABATO sì, perché il sabato non fa parte di quella redistribuzione
   * dinamica (per lui come per tutti gli altri). */
  function targetSettimana(emp: Employee, sundayData: string): number {
    if (!isMD) return emp.ore_settimanali
    const sunday = new Date(sundayData + 'T00:00:00')
    const start = new Date(sunday)
    start.setDate(start.getDate() - 6)
    const isCarlo = emp.nome.trim() === 'Carlo'
    const festiviRilevanti = giorni.filter(g => {
      const d = new Date(g.data + 'T00:00:00')
      if (d < start || d > sunday) return false
      if (d.getDay() === 0) return false
      if (!festiviMap[g.data]) return false
      if (isCarlo && d.getDay() !== 6) return false // festivo Lun-Ven di Carlo → già ridistribuito
      return true
    })
    if (festiviRilevanti.length === 0) return emp.ore_settimanali
    const oreDaTogliere = festiviRilevanti.reduce((sum, g) => sum + oreAttesePerGiornoFestivo(emp, g.data), 0)
    return Math.max(0, emp.ore_settimanali - oreDaTogliere)
  }

  /** True se il dipendente ha usato Ferie (F) in uno dei 7 giorni che finiscono con `sundayData`. */
  function haUsatoFerieSettimana(empId: string, sundayData: string): boolean {
    const sunday = new Date(sundayData + 'T00:00:00')
    const start = new Date(sunday)
    start.setDate(start.getDate() - 6)
    return unavailabilities.some(u => {
      if (u.employee_id !== empId || u.tipo_assenza !== 'F') return false
      const d = new Date(u.data + 'T00:00:00')
      return d >= start && d <= sunday
    })
  }

  function totColor(tot: number, target: number): string {
    if (shifts.length === 0) return 'bg-gray-100 text-gray-400' // settimana non ancora generata
    const diff = Math.abs(tot - target)
    return diff <= 1 ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
  }

  function toggleModalDate(data: string) {
    const next = new Set(modalSelected)
    if (next.has(data)) next.delete(data)
    else next.add(data)
    setModalSelected(next)
    setModalSaved(false)
  }

  async function salvaIndisponibilitaModal() {
    if (!dettaglioEmp || !schedule) return
    setModalSaving(true)

    // Saldo ferie/permessi: calcola il delta rispetto allo stato PRIMA di salvare
    // (le date fuori da modalSelected vengono cancellate dall'API, quindi vanno
    // "restituite" al saldo se erano F/P; le nuove F/P vengono scalate).
    const prevRecords = unavailabilities.filter(u => u.employee_id === dettaglioEmp.id)
    const nuoveDate = Array.from(modalSelected)

    const oldFDate = new Set(prevRecords.filter(u => u.tipo_assenza === 'F').map(u => u.data))
    const newFDate = new Set(modalTipoAssenza === 'F' ? nuoveDate : [])
    const deltaFerieGiorni = newFDate.size - oldFDate.size

    // Permesso a ore: se specificato, si scalano solo quelle ore (non il turno intero).
    const oreParzialiNum = modalOreParziali.trim() !== '' ? parseFloat(modalOreParziali) : null

    const oldPRecords = prevRecords.filter(u => u.tipo_assenza === 'P')
    const oldPDate = oldPRecords.map(u => u.data)
    const newPDate = modalTipoAssenza === 'P' ? nuoveDate : []
    const addedP = newPDate.filter(d => !oldPDate.includes(d))
    const removedP = oldPDate.filter(d => !newPDate.includes(d))
    const deltaPermessiOre =
      addedP.reduce((sum, d) => sum + (oreParzialiNum ?? oreFromOrario(getShift(dettaglioEmp.id, d)?.ora_inizio, getShift(dettaglioEmp.id, d)?.ora_fine)), 0) -
      removedP.reduce((sum, d) => {
        const vecchio = oldPRecords.find(u => u.data === d)
        return sum + (vecchio?.ore_parziali ?? oreFromOrario(getShift(dettaglioEmp.id, d)?.ora_inizio, getShift(dettaglioEmp.id, d)?.ora_fine))
      }, 0)

    const res = await fetch('/api/unavailabilities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: dettaglioEmp.token,
        schedule_id: schedule.id,
        dates: nuoveDate,
        motivo: modalMotivo,
        tipo_assenza: modalTipoAssenza,
        ore_parziali: oreParzialiNum,
        inserito_da: 'manager',
      }),
    })

    if (res.ok && isMD && (deltaFerieGiorni !== 0 || deltaPermessiOre !== 0)) {
      await fetch('/api/ferie-saldo', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employee_id: dettaglioEmp.id,
          anno,
          delta_ferie_giorni: deltaFerieGiorni,
          delta_permessi_ore: deltaPermessiOre,
        }),
      })
    }

    setModalSaving(false)
    if (res.ok) {
      setModalSaved(true)
      await loadData()
    }
  }

  async function cycleShift(empId: string, data: string) {
    if (!schedule) return
    const emp = employees.find(e => e.id === empId)
    if (!emp) return
    const isDomenica = giorni.find(g => g.data === data)?.domenica ?? false
    const existing = getShift(empId, data)
    const currentTipo: TurnoTipo = (existing?.tipo as TurnoTipo) ?? 'riposo'
    const nextTipo = nextTurno(currentTipo, emp, isDomenica, isMD)
    const orario = nextTipo !== 'riposo' ? (isMD ? ORARI_TURNO_MD[nextTipo] : ORARI_TURNO[nextTipo]) : null

    // Aggiornamento ottimistico
    if (existing) {
      setShifts(prev => prev.map(s =>
        s.employee_id === empId && s.data === data
          ? { ...s, tipo: nextTipo, ora_inizio: orario?.inizio, ora_fine: orario?.fine }
          : s
      ))
    } else {
      const optimistic: Shift = {
        id: `temp-${empId}-${data}`,
        schedule_id: schedule.id,
        employee_id: empId,
        data,
        tipo: nextTipo,
        ora_inizio: orario?.inizio,
        ora_fine: orario?.fine,
      }
      setShifts(prev => [...prev, optimistic])
    }

    // Persist su Supabase
    if (existing) {
      await supabase.from('shifts').update({ tipo: nextTipo, ora_inizio: orario?.inizio ?? null, ora_fine: orario?.fine ?? null }).eq('id', existing.id)
    } else {
      const { data: newShift } = await supabase.from('shifts')
        .insert({ schedule_id: schedule.id, employee_id: empId, data, tipo: nextTipo, ora_inizio: orario?.inizio ?? null, ora_fine: orario?.fine ?? null })
        .select().single()
      if (newShift) {
        setShifts(prev => prev.map(s =>
          s.id === `temp-${empId}-${data}` ? newShift : s
        ))
      }
    }
  }

  // Turni brevi (3h, casi eccezionali) — disponibili per tutti i dipendenti MD su richiesta di Giacomo.
  const ORARI_TURNO_BREVE = ['11/14', '12/15', '13/16', '17/20']

  /** Orari validi per cella MD, in base alle ore settimanali contrattuali del dipendente
   * (evita che il click ciclico assegni un turno con più ore di quante ne consenta il contratto). */
  function getOrariValidi(oreSettimanali: number): string[] {
    const base = ['—'] // riposo sempre disponibile

    if (oreSettimanali === 22) return [
      ...base,
      '08/11', '09/12', '10/13', // mattina 3h
      '09/13', '10/14', '11/15', // mattina 4h
      '08/13',                    // mattina 5h
      '08/14',                    // mattina 6h (entro max_ore_giorno=6)
      '17/20',                    // pomeriggio 3h
      '16/20',                    // pomeriggio 4h
      '15/20',                    // pomeriggio 5h
      '14/20',                    // pomeriggio 6h (entro max_ore_giorno=6)
      ...ORARI_TURNO_BREVE,
    ]

    if (oreSettimanali === 28) return [
      ...base,
      '08/12', '09/13', '10/14', '11/15', // mattina 4h
      '08/13', '09/14',           // mattina 5h
      '08/14',                    // mattina 6h
      '16/20',                    // pomeriggio 4h
      '15/20',                    // pomeriggio 5h
      '14/20',                    // pomeriggio 6h
      ...ORARI_TURNO_BREVE,
    ]

    if (oreSettimanali === 35) return [
      ...base,
      '11/15',                    // mattina 4h
      '08/13', '09/14',           // mattina 5h
      '08/14',                    // mattina 6h
      '15/20',                    // pomeriggio 5h
      '14/20',                    // pomeriggio 6h
      ...ORARI_TURNO_BREVE,
    ]

    if (oreSettimanali === 30) return [
      // Max: sempre 5h fisso
      '08/13',  // mattina 5h
      '14/19',  // pomeriggio 5h
      '—',
      ...ORARI_TURNO_BREVE,
    ]

    if (oreSettimanali === 36) return [
      ...base,
      '08/14', // mattina 6h standard
      '14/20', // pomeriggio 6h
      '08/16', // yuri full
      '13/16', // yuri salumeria
      ...ORARI_TURNO_BREVE,
    ]

    // Default
    return [...base, '08/14', '14/20', '08/20', ...ORARI_TURNO_BREVE]
  }

  /** Converte l'orario scelto nel popup ("HH/HH" o "—") nel tipo turno + ora_inizio/ora_fine.
   * Max (30h) usa sempre mattina_corta/pomeriggio_corto (5h fisse, mai lo standard 6h) — la sua
   * fascia pomeriggio termina alle 19:00, non alle 20:00 come gli altri contratti, quindi va
   * gestita esplicitamente per non ricadere nel fallback "mattina" (bug: tipo sbagliato con
   * orario pomeridiano). */
  function parseOrarioSelezionato(orario: string, emp?: Employee): { tipo: TurnoTipo; ora_inizio: string | null; ora_fine: string | null } {
    if (orario === '—') return { tipo: 'riposo', ora_inizio: null, ora_fine: null }
    const [iniN, finN] = orario.split('/').map(n => parseInt(n, 10))
    const ora_inizio = `${String(iniN).padStart(2, '0')}:00`
    const ora_fine = `${String(finN).padStart(2, '0')}:00`
    if (emp?.nome === 'Max' && emp.ore_settimanali === 30) {
      return finN === 19 ? { tipo: 'pomeriggio_corto', ora_inizio, ora_fine } : { tipo: 'mattina_corta', ora_inizio, ora_fine }
    }
    if (iniN === 8 && finN === 16) return { tipo: 'yuri_full', ora_inizio, ora_fine }
    // 13/16 è il turno fisso di Yuri (yuri_pomeriggio) SOLO per lui — per chiunque altro è
    // un turno breve eccezionale (turno_breve_13_16), stessa fascia oraria ma significato diverso.
    if (iniN === 13 && finN === 16) return { tipo: emp?.nome === 'Yuri' ? 'yuri_pomeriggio' : 'turno_breve_13_16', ora_inizio, ora_fine }
    if (iniN === 11 && finN === 14) return { tipo: 'turno_breve_11_14', ora_inizio, ora_fine }
    if (iniN === 12 && finN === 15) return { tipo: 'turno_breve_12_15', ora_inizio, ora_fine }
    if (iniN === 17 && finN === 20) return { tipo: 'turno_breve_17_20', ora_inizio, ora_fine }
    if (iniN === 8 && finN === 20) return { tipo: 'full', ora_inizio, ora_fine }
    if (finN === 20) return { tipo: 'pomeriggio', ora_inizio, ora_fine }
    return { tipo: 'mattina', ora_inizio, ora_fine }
  }

  async function handleCellSelect(empId: string, data: string, orario: string) {
    if (!schedule) return
    const emp = employees.find(e => e.id === empId)
    const { tipo, ora_inizio, ora_fine } = parseOrarioSelezionato(orario, emp)
    const existing = getShift(empId, data)

    if (existing) {
      setShifts(prev => prev.map(s => s.id === existing.id ? { ...s, tipo, ora_inizio: ora_inizio ?? undefined, ora_fine: ora_fine ?? undefined } : s))
      await supabase.from('shifts').update({ tipo, ora_inizio, ora_fine }).eq('id', existing.id)
    } else {
      const optimistic: Shift = {
        id: `temp-${empId}-${data}`,
        schedule_id: schedule.id,
        employee_id: empId,
        data,
        tipo,
        ora_inizio: ora_inizio ?? undefined,
        ora_fine: ora_fine ?? undefined,
      }
      setShifts(prev => [...prev, optimistic])
      const { data: newShift } = await supabase.from('shifts')
        .insert({ schedule_id: schedule.id, employee_id: empId, data, tipo, ora_inizio, ora_fine })
        .select().single()
      if (newShift) {
        setShifts(prev => prev.map(s => s.id === `temp-${empId}-${data}` ? newShift : s))
      }
    }
    setPopupCell(null)
  }

  // Raggruppa unavailabilities per dipendente per il pannello
  const unavByEmployee = employees.reduce<Record<string, string[]>>((acc, emp) => {
    const dates = unavailabilities
      .filter(u => u.employee_id === emp.id)
      .map(u => u.data)
      .sort()
    if (dates.length > 0) acc[emp.id] = dates
    return acc
  }, {})

  if (error) return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="bg-red-50 border border-red-200 rounded-xl p-6 max-w-2xl mx-auto">
        <h2 className="text-red-700 font-bold text-lg mb-2">❌ Errore di caricamento</h2>
        <pre className="text-red-600 text-sm whitespace-pre-wrap">{error}</pre>
        <div className="mt-4 text-xs text-gray-500">
          Store: {storeId ?? '(vuoto)'} · URL: {process.env.NEXT_PUBLIC_SUPABASE_URL?.slice(0,30) || '(vuoto)'}
        </div>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          {isMD ? (
            <div className="flex items-center gap-3">
              <img
                src="/MD_Italia_Logo.svg.jpg"
                alt="MD Logo"
                className="h-12 w-auto"
              />
              <div>
                <h1 className="text-xl font-bold text-gray-800 leading-tight">
                  Generatore di Turni — Lanciano
                </h1>
                <p className="text-xs text-gray-400">by Maia &amp; Giacomo</p>
              </div>
            </div>
          ) : (
            <h1 className="text-2xl font-bold text-gray-800">📅 Gestione Turni</h1>
          )}
          <button onClick={logout}
            className="text-sm text-gray-500 hover:text-gray-700 border rounded-lg px-3 py-1.5 hover:bg-gray-50 transition">
            Esci
          </button>
        </div>

        {/* Selettore mese */}
        <div className="flex gap-3 mb-6 items-center flex-wrap">
          <select className="border rounded px-3 py-2 bg-white text-gray-800" value={mese} onChange={e => setMese(+e.target.value)}>
            {MESI.map((m, i) => <option key={i} value={i+1}>{m}</option>)}
          </select>
          <select className="border rounded px-3 py-2 bg-white text-gray-800" value={anno} onChange={e => setAnno(+e.target.value)}>
            {[2025,2026,2027].map(a => <option key={a} value={a}>{a}</option>)}
          </select>

          {isMD && schedule && (
            <select
              className="border rounded px-3 py-2 bg-white text-gray-800"
              value={settimanaSelezionata}
              onChange={e => setSettimanaSelezionata(e.target.value === '' ? '' : +e.target.value)}
            >
              <option value="">Tutto il mese</option>
              {settimaneMese.map((s, i) => (
                <option key={i} value={i}>Sett. {i + 1}: {s.label}</option>
              ))}
            </select>
          )}
          {isMD && settimanaAttiva && schedule && (
            <button onClick={generaSettimana} disabled={loading}
              className="bg-purple-600 text-white px-4 py-2 rounded hover:bg-purple-700 disabled:opacity-50">
              {loading ? 'Generando...' : '⚡ Genera settimana'}
            </button>
          )}
          {isMD && settimanaAttiva && schedule && (
            <button onClick={resetSettimana} disabled={loading}
              className="bg-red-100 text-red-600 px-4 py-2 rounded hover:bg-red-200 border border-red-200 disabled:opacity-50">
              🗑️ Reset settimana
            </button>
          )}
          {isMD && settimanaAttiva && (
            <button onClick={lavoraSuSettimana}
              className="bg-purple-700 text-white px-4 py-2 rounded hover:bg-purple-800 flex items-center gap-2">
              ✨ Lavora su questa settimana
            </button>
          )}

          {!schedule ? (
            <button onClick={createSchedule} className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">
              Crea piano mese
            </button>
          ) : (
            <>
              <button onClick={generateTurni} disabled={loading}
                className="bg-purple-600 text-white px-4 py-2 rounded hover:bg-purple-700 disabled:opacity-50">
                {loading ? 'Generando...' : '⚡ Genera turni'}
              </button>
              {isMD && shifts.length > 0 && (
                <button onClick={controllaTurni}
                  className="bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700 flex items-center gap-2">
                  🔍 Controlla turni
                </button>
              )}
              {isMD && shifts.length > 0 && (
                <button onClick={() => { setSettimanaChiusure(0); setShowChiusure(true) }}
                  className="bg-slate-700 text-white px-4 py-2 rounded hover:bg-slate-800 flex items-center gap-2">
                  🔒 Chiusure
                </button>
              )}
              {isMD && shifts.length > 0 && (
                <button onClick={() => { setSettimanaMezzogiorno(0); setShowMezzogiorno(true) }}
                  className="bg-slate-700 text-white px-4 py-2 rounded hover:bg-slate-800 flex items-center gap-2">
                  🕐 Mezzogiorno
                </button>
              )}
              {shifts.length > 0 && (
                <button onClick={resetMese} className="bg-red-50 text-red-600 border border-red-200 px-4 py-2 rounded hover:bg-red-100">
                  🗑️ Reset mese
                </button>
              )}
              {schedule.stato === 'bozza' && shifts.length > 0 && (
                <button onClick={pubblicaTurni} className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700">
                  ✅ Pubblica
                </button>
              )}
              {shifts.length > 0 && (
                <>
                  <button onClick={() => exportPDF()} className="bg-gray-600 text-white px-4 py-2 rounded hover:bg-gray-700">
                    📄 PDF Mese
                  </button>
                  <button onClick={exportPDFSettimana} className="bg-gray-500 text-white px-4 py-2 rounded hover:bg-gray-600">
                    📄 PDF Settimana
                  </button>
                </>
              )}
              <span className={`px-3 py-1 rounded-full text-sm font-medium ${
                schedule.stato === 'pubblicato' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'
              }`}>
                {schedule.stato === 'pubblicato' ? '✅ Pubblicato' : '📝 Bozza'}
              </span>
            </>
          )}
        </div>

        {/* Dipendenti */}
        <div className="bg-white rounded-xl shadow-sm p-4 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-gray-700">👤 Dipendenti</h2>
            <button
              onClick={() => setShowAddForm(v => !v)}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors">
              {showAddForm ? 'Annulla' : '+ Aggiungi dipendente'}
            </button>
          </div>

          {showAddForm && (
            <div className="flex gap-3 mb-4 flex-wrap items-center bg-gray-50 rounded-lg p-3">
              <input type="text" placeholder="Nome dipendente"
                className="border rounded px-3 py-2 flex-1 min-w-48 text-sm"
                value={newEmp.nome} onChange={e => setNewEmp({...newEmp, nome: e.target.value})} />
              <select className="border rounded px-3 py-2 text-sm"
                value={newEmp.ore_settimanali} onChange={e => setNewEmp({...newEmp, ore_settimanali: +e.target.value})}>
                {isMD ? (
                  <>
                    <option value={22}>22h/sett</option>
                    <option value={28}>28h/sett</option>
                    <option value={30}>30h/sett</option>
                    <option value={35}>35h/sett</option>
                    <option value={36}>36h/sett</option>
                    <option value={46}>46h/sett</option>
                  </>
                ) : (
                  <>
                    <option value={20}>20h/sett</option>
                    <option value={30}>30h/sett</option>
                    <option value={40}>40h/sett</option>
                  </>
                )}
              </select>
              <button onClick={addEmployee} className="bg-gray-800 text-white px-4 py-2 rounded text-sm hover:bg-gray-700">
                Aggiungi
              </button>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {employees.map(e => (
              <div key={e.id}
                onClick={() => setDettaglioEmp(e)}
                className="flex items-center gap-2 bg-gray-100 hover:bg-gray-200 rounded-lg px-3 py-2 text-sm cursor-pointer transition-colors">
                <button onClick={ev => { ev.stopPropagation(); setDettaglioEmp(e) }} className="font-medium hover:text-blue-600 transition-colors">{e.nome}</button>
                <span className="text-gray-500">{e.ore_settimanali}h</span>
                <button
                  onClick={ev => { ev.stopPropagation(); copyLink(e) }}
                  className="text-xs px-2 py-0.5 rounded transition-colors duration-150 bg-blue-100 text-blue-700 hover:bg-blue-200">
                  {copiedToken === e.token ? '✅ Copiato!' : '🔗 Link'}
                </button>
                <button
                  onClick={ev => { ev.stopPropagation(); cancellaEmployee(e) }}
                  className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-600 hover:bg-red-200 transition-colors duration-150">
                  🗑
                </button>
              </div>
            ))}
          </div>

          {/* Cestino */}
          {cestino.length > 0 && (
            <div className="mt-4 border-t pt-3">
              <button
                onClick={() => setShowCestino(v => !v)}
                className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1">
                🗑 Cestino ({cestino.length}) {showCestino ? '▲' : '▼'}
              </button>
              {showCestino && (
                <div className="mt-2 space-y-1">
                  {cestino.map(e => (
                    <div key={e.id} className="flex items-center gap-2 bg-red-50 rounded-lg px-3 py-2 text-sm">
                      <span className="text-gray-500 line-through">{e.nome}</span>
                      <span className="text-gray-400 text-xs">{e.ore_settimanali}h</span>
                      <button
                        onClick={() => ripristinaEmployee(e)}
                        className="text-xs px-2 py-0.5 rounded bg-green-100 text-green-700 hover:bg-green-200 ml-auto">
                        Ripristina
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={svuotaCestino}
                    className="mt-2 text-xs text-red-600 hover:text-red-800 font-medium border border-red-200 rounded px-3 py-1 hover:bg-red-50">
                    🗑 Svuota cestino (elimina definitivamente)
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Banner avvisi ore in eccesso rispetto al contratto */}
        {isMD && shifts.length > 0 && employees.filter(emp => {
          const settimane = getSettimaneLunDom(giorni, mese)
          return settimane.some(sett => {
            const ore = sett.giorni.reduce((sum, g) => sum + oreLavorateGiorno(emp.id, g.data), 0)
            return ore > emp.ore_settimanali + 1
          })
        }).map(emp => (
          <div key={emp.id} className="bg-red-50 border border-red-200 rounded-lg px-4 py-2 text-sm text-red-700 mb-2">
            ⚠️ <strong>{emp.nome}</strong> ha ore in eccesso rispetto al contratto ({emp.ore_settimanali}h) — clicca su 🔍 Controlla turni
          </div>
        ))}

        {/* Tabella turni */}
        {shifts.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm overflow-x-auto mb-6">
            <table className="w-full text-sm" style={{ minWidth: '1800px' }}>
              <thead>
                <tr className="border-b">
                  <th className="text-left p-3 font-semibold text-gray-700 sticky left-0 bg-white min-w-32">Dipendente</th>
                  {Array.from({ length: offsetLunedi }).map((_, i) => (
                    <th key={`empty-h-${i}`} className={`p-2 text-center ${isMD ? 'min-w-14' : 'min-w-10'} bg-gray-50 border-b`}>
                      <div className={`text-xs ${i >= 5 ? 'text-red-300' : 'text-gray-300'}`}>
                        {['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'][i]}
                      </div>
                    </th>
                  ))}
                  {giorniOrdinati.map(g => {
                    const inSettimanaAttiva = !!settimanaAttiva && settimanaAttiva.giorni.some(sg => sg.data === g.data)
                    const nomeFestivo = isMD ? festiviMap[g.data] : undefined
                    return (
                      <Fragment key={g.data}>
                        <th className={`p-2 text-center font-medium ${isMD ? 'min-w-14' : 'min-w-10'} ${g.domenica || nomeFestivo ? 'bg-red-50 text-red-400' : 'text-gray-600'} ${inSettimanaAttiva ? 'border-t-2 border-b-2 border-blue-500' : ''}`}>
                          <div className="text-xs">{g.giorno}</div>
                          <div className="text-xs text-gray-400">{g.num}</div>
                          {nomeFestivo && <div className="text-xs text-purple-500">{nomeFestivo}</div>}
                        </th>
                        {isMD && g.domenica && (
                          <th className="p-2 text-center font-semibold text-gray-700 bg-gray-50 min-w-16">TOT</th>
                        )}
                      </Fragment>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {employees.map(emp => (
                  <tr key={emp.id} className="border-b hover:bg-gray-50">
                    <td className="p-3 font-medium text-gray-800 sticky left-0 bg-white">
                      <button
                        onClick={() => setDettaglioEmp(emp)}
                        className="text-left hover:text-blue-600 transition-colors">
                        <div>{emp.nome}</div>
                        <div className="text-xs text-gray-400">
                          {emp.ore_settimanali}h{isMD && emp.ruolo ? ` • ${emp.ruolo === 'cassiere' ? 'cassiere' : 'non cassiere'}` : ''}
                        </div>
                      </button>
                    </td>
                    {Array.from({ length: offsetLunedi }).map((_, i) => (
                      <td key={`empty-b-${emp.id}-${i}`} className="bg-gray-50 border-b" />
                    ))}
                    {giorniOrdinati.map(g => {
                      const shift = getShift(emp.id, g.data)
                      const tipo = shift?.tipo || 'riposo'
                      const isPermesso = hasUnavailability(emp.id, g.data)
                      const nomeFestivo = isMD ? festiviMap[g.data] : undefined
                      const domenicaBloccata = (g.domenica && !isMD) || !!nomeFestivo
                      const cellBg = g.domenica || nomeFestivo ? (isMD ? 'bg-purple-50' : 'bg-red-50') : ''
                      const inSettimanaAttiva = !!settimanaAttiva && settimanaAttiva.giorni.some(sg => sg.data === g.data)
                      const bordoSettimana = inSettimanaAttiva ? 'border-t-2 border-b-2 border-blue-500' : ''

                      const dayCell = nomeFestivo ? (
                        <td className={`p-1 text-center ${cellBg} ${bordoSettimana}`}>
                          <span title={nomeFestivo}
                            className="inline-block px-1 py-0.5 rounded text-xs font-bold bg-purple-100 text-purple-700">
                            FEST
                          </span>
                        </td>
                      ) : isPermesso ? (() => {
                        const assenzaCode = getAssenzaCode(emp.id, g.data)
                        const colore = ASSENZA_COLOR[assenzaCode] ?? 'bg-orange-100 text-orange-800'
                        return (
                          <td className={`p-1 text-center ${cellBg} ${bordoSettimana}`}>
                            <button
                              onClick={() => !domenicaBloccata && cycleAssenza(emp.id, g.data)}
                              disabled={domenicaBloccata}
                              title={`${ASSENZA_LABEL[assenzaCode]} — click per cambiare tipo`}
                              className={`inline-block px-1 py-0.5 rounded text-xs font-bold hover:opacity-80 disabled:cursor-not-allowed ${colore}`}>
                              {assenzaCode}
                            </button>
                          </td>
                        )
                      })() : (
                        <td className={`p-1 text-center ${cellBg} ${bordoSettimana}`}>
                          <button
                            onClick={(e) => {
                              if (domenicaBloccata) return
                              if (isMD) {
                                const rect = e.currentTarget.getBoundingClientRect()
                                setPopupCell({ empId: emp.id, data: g.data, x: rect.left, y: rect.bottom })
                              } else {
                                cycleShift(emp.id, g.data)
                              }
                            }}
                            disabled={domenicaBloccata}
                            title={isMD ? `Click per scegliere orario (attuale: ${tipo})` : `Click per cambiare (attuale: ${tipo})`}
                            className={`inline-block px-1 py-0.5 rounded hover:opacity-80 disabled:cursor-not-allowed whitespace-nowrap ${TURNO_COLOR[tipo]}`}>
                            {isMD && tipo !== 'riposo' ? (
                              <div className="flex flex-col items-center leading-tight">
                                <span className="text-xs font-bold text-gray-500">{getOreDisplay(tipo, shift)}h</span>
                                <span className="text-xs font-medium">{getTurnoDisplay(tipo, isMD, shift)}</span>
                              </div>
                            ) : (
                              <span className="text-xs font-bold">{getTurnoDisplay(tipo, isMD, shift)}</span>
                            )}
                          </button>
                        </td>
                      )

                      const showTot = isMD && g.domenica
                      const tot = showTot ? totSettimana(emp.id, g.data) : 0
                      const haUsatoFerie = showTot && haUsatoFerieSettimana(emp.id, g.data)
                      const saldoEmp = ferieSaldi[emp.id]
                      const ferieRimanenti = saldoEmp ? (saldoEmp.ferie_giorni_totali - saldoEmp.ferie_giorni_usati) : null

                      return (
                        <Fragment key={g.data}>
                          {dayCell}
                          {showTot && (
                            <td className={`p-1 text-center text-xs font-bold ${totColor(tot, targetSettimana(emp, g.data))}`}>
                              <div>{tot}h</div>
                              {haUsatoFerie && ferieRimanenti !== null && (
                                <div className="text-[10px] font-normal text-gray-500">F:{ferieRimanenti.toFixed(0)}g</div>
                              )}
                            </td>
                          )}
                        </Fragment>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="p-3 text-xs text-gray-400 flex gap-4 flex-wrap">
              {/* Stroili: le celle mostrano ancora lettere (M/Pm/F), la legenda resta utile. */}
              {!isMD && <span><strong>M</strong> = Mattina 9-14</span>}
              {!isMD && <span><strong>Pm</strong> = Pomeriggio 14-20</span>}
              {!isMD && <span><strong>F</strong> = Full 9-20</span>}
              {!isMD && <span><strong>—</strong> = Riposo</span>}
              {/* MD: le celle mostrano già gli orari — nessuna voce turno in legenda, solo assenze. */}
              {isMD && <span className="text-pink-700">11/14, 12/15, 13/16, 17/20 = Turno breve (3h)</span>}
              <span><strong className="text-yellow-700">F</strong><span className="text-yellow-700"> = Ferie</span></span>
              <span><strong className="text-yellow-700">P</strong><span className="text-yellow-700"> = Permesso</span></span>
              <span><strong className="text-yellow-700">R</strong><span className="text-yellow-700"> = Recupero</span></span>
              <span><strong className="text-red-700">M</strong><span className="text-red-700"> = Malattia</span></span>
              <span><strong className="text-yellow-700">MT</strong><span className="text-yellow-700"> = Maternità</span></span>
            </div>
          </div>
        )}

        {/* Popup orari validi — sostituisce il click ciclico per MD (rispetta i limiti ore contratto) */}
        {popupCell && (() => {
          const emp = employees.find(e => e.id === popupCell.empId)
          if (!emp) return null
          return (
            <>
              <div className="fixed inset-0 z-[999]" onClick={() => setPopupCell(null)} />
              <div style={{ position: 'fixed', top: popupCell.y, left: popupCell.x, zIndex: 1000 }}
                className="bg-white border rounded-lg shadow-lg p-2 min-w-24 max-h-64 overflow-y-auto">
                {getOrariValidi(emp.ore_settimanali).map(orario => (
                  <button key={orario}
                    className="block w-full text-left px-3 py-1 hover:bg-gray-100 text-sm rounded whitespace-nowrap"
                    onClick={() => handleCellSelect(popupCell.empId, popupCell.data, orario)}>
                    {orario}
                  </button>
                ))}
              </div>
            </>
          )
        })()}

        {/* Pannello laterale "Chiusure" — copertura chiusura 20:00 per settimana (Lun-Sab) */}
        {showChiusure && isMD && (() => {
          const settimane = getSettimaneLunDom(giorni, mese)
          const idx = Math.min(Math.max(settimanaChiusure, 0), Math.max(settimane.length - 1, 0))
          const settimana = settimane[idx]
          const giorniLavorativi = settimana ? settimana.giorni.filter(g => !g.domenica) : []

          return (
            <>
              <div className="fixed inset-0 bg-black/20 z-40" onClick={() => setShowChiusure(false)} />
              <div className="fixed top-0 right-0 h-full bg-white shadow-2xl z-50 flex flex-col" style={{ width: 320 }}>
                <div className="flex items-center justify-between px-4 py-3 border-b bg-slate-700">
                  <h3 className="text-white font-semibold text-sm">🔒 Chiusure — {MESI[mese - 1]} {anno}</h3>
                  <button onClick={() => setShowChiusure(false)} className="text-white/80 hover:text-white text-lg">✕</button>
                </div>

                <div className="flex items-center justify-between px-4 py-2 border-b bg-gray-50">
                  <button onClick={() => setSettimanaChiusure(i => Math.max(0, i - 1))} disabled={idx === 0}
                    className="px-2 py-1 rounded hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed">←</button>
                  <span className="text-xs text-gray-500">{settimana?.label ?? '—'}</span>
                  <button onClick={() => setSettimanaChiusure(i => Math.min(settimane.length - 1, i + 1))} disabled={idx >= settimane.length - 1}
                    className="px-2 py-1 rounded hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed">→</button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  {giorniLavorativi.map(g => {
                    const isSabato = g.giorno === 'Sab'
                    const minRichiesto = isSabato ? 4 : 3
                    const chiusuristi = employees
                      .map(emp => ({ emp, shift: getShift(emp.id, g.data) }))
                      .filter(({ shift }) => shift?.ora_fine?.startsWith('20:00'))
                    const ok = chiusuristi.length >= minRichiesto

                    return (
                      <div key={g.data} className={`rounded-lg border p-3 ${ok ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                        <div className="text-sm font-semibold text-gray-800 mb-1">{g.giorno === 'Sab' ? 'Sabato' : ['Lun','Mar','Mer','Gio','Ven'].includes(g.giorno) ? { Lun: 'Lunedì', Mar: 'Martedì', Mer: 'Mercoledì', Gio: 'Giovedì', Ven: 'Venerdì' }[g.giorno] : g.giorno} {g.num} {MESI[mese - 1]}</div>
                        {ok ? (
                          <div className="text-sm text-green-700">
                            ✅ {chiusuristi.map(({ emp, shift }) => `${emp.nome} ${formatOraShort(shift?.ora_inizio)}/20`).join(' · ')}
                            <span className="text-xs text-green-600"> ({chiusuristi.length} person{chiusuristi.length === 1 ? 'a' : 'e'})</span>
                          </div>
                        ) : (
                          <div>
                            <div className="text-sm text-red-700 font-medium">⚠️ Solo {chiusuristi.length} person{chiusuristi.length === 1 ? 'a' : 'e'} — manca copertura!</div>
                            {chiusuristi.length > 0 && (
                              <div className="text-sm text-red-600 mt-1">
                                {chiusuristi.map(({ emp, shift }) => `${emp.nome} ${formatOraShort(shift?.ora_inizio)}/20`).join(' · ')}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                  {giorniLavorativi.length === 0 && (
                    <p className="text-sm text-gray-400">Nessun giorno lavorativo in questa settimana.</p>
                  )}
                </div>
              </div>
            </>
          )
        })()}

        {/* Pannello laterale "Mezzogiorno" — copertura fascia 12:00-14:00 per settimana (Lun-Sab) */}
        {showMezzogiorno && isMD && (() => {
          const settimane = getSettimaneLunDom(giorni, mese)
          const idx = Math.min(Math.max(settimanaMezzogiorno, 0), Math.max(settimane.length - 1, 0))
          const settimana = settimane[idx]
          const giorniLavorativi = settimana ? settimana.giorni.filter(g => !g.domenica) : []
          const FASCIA_INIZIO = '12:00'
          const FASCIA_FINE = '14:00'
          const MIN_PRESENTI = 2

          return (
            <>
              <div className="fixed inset-0 bg-black/20 z-40" onClick={() => setShowMezzogiorno(false)} />
              <div className="fixed top-0 right-0 h-full bg-white shadow-2xl z-50 flex flex-col" style={{ width: 320 }}>
                <div className="flex items-center justify-between px-4 py-3 border-b bg-slate-700">
                  <h3 className="text-white font-semibold text-sm">🕐 Mezzogiorno — {MESI[mese - 1]} {anno}</h3>
                  <button onClick={() => setShowMezzogiorno(false)} className="text-white/80 hover:text-white text-lg">✕</button>
                </div>

                <div className="flex items-center justify-between px-4 py-2 border-b bg-gray-50">
                  <button onClick={() => setSettimanaMezzogiorno(i => Math.max(0, i - 1))} disabled={idx === 0}
                    className="px-2 py-1 rounded hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed">←</button>
                  <span className="text-xs text-gray-500">{settimana?.label ?? '—'}</span>
                  <button onClick={() => setSettimanaMezzogiorno(i => Math.min(settimane.length - 1, i + 1))} disabled={idx >= settimane.length - 1}
                    className="px-2 py-1 rounded hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed">→</button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  {giorniLavorativi.map(g => {
                    const presenti = employees
                      .map(emp => ({ emp, shift: getShift(emp.id, g.data) }))
                      .filter(({ shift }) => shift?.ora_inizio && shift?.ora_fine && shift.ora_inizio < FASCIA_FINE && shift.ora_fine > FASCIA_INIZIO)
                    const ok = presenti.length >= MIN_PRESENTI

                    return (
                      <div key={g.data} className={`rounded-lg border p-3 ${ok ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                        <div className="text-sm font-semibold text-gray-800 mb-1">{g.giorno === 'Sab' ? 'Sabato' : ['Lun','Mar','Mer','Gio','Ven'].includes(g.giorno) ? { Lun: 'Lunedì', Mar: 'Martedì', Mer: 'Mercoledì', Gio: 'Giovedì', Ven: 'Venerdì' }[g.giorno] : g.giorno} {g.num} {MESI[mese - 1]}</div>
                        {presenti.length === 0 ? (
                          <div className="text-sm text-red-700 font-medium">⚠️ Nessuno — manca copertura 12-14!</div>
                        ) : ok ? (
                          <div className="text-sm text-green-700">
                            ✅ {presenti.map(({ emp, shift }) => `${emp.nome} (${formatOraShort(shift?.ora_inizio)}/${formatOraShort(shift?.ora_fine)})`).join(' · ')}
                            <span className="text-xs text-green-600"> ({presenti.length} person{presenti.length === 1 ? 'a' : 'e'})</span>
                          </div>
                        ) : (
                          <div>
                            <div className="text-sm text-red-700 font-medium">⚠️ {presenti.map(({ emp, shift }) => `${emp.nome} (${formatOraShort(shift?.ora_inizio)}/${formatOraShort(shift?.ora_fine)})`).join(' · ')} — solo {presenti.length} persona, manca copertura!</div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                  {giorniLavorativi.length === 0 && (
                    <p className="text-sm text-gray-400">Nessun giorno lavorativo in questa settimana.</p>
                  )}
                </div>
              </div>
            </>
          )
        })()}

        {/* Pannello permessi mensili */}
        {Object.keys(unavByEmployee).length > 0 && (
          <div className="bg-white rounded-xl shadow-sm p-4">
            <h2 className="font-semibold text-gray-700 mb-3">🟡 Permessi del mese</h2>
            <div className="space-y-2">
              {employees
                .filter(emp => unavByEmployee[emp.id])
                .map(emp => {
                  const dates = unavByEmployee[emp.id]
                  const formatted = dates.map(d => {
                    const dt = new Date(d + 'T00:00:00')
                    return `${dt.getDate()} ${MESI[dt.getMonth()]}`
                  })
                  return (
                    <div key={emp.id} className="flex items-start gap-3 py-2 border-b last:border-0">
                      <button onClick={() => setDettaglioEmp(emp)} className="font-medium text-gray-800 min-w-28 text-left hover:text-blue-600 transition-colors">{emp.nome}</button>
                      <span className="text-gray-600 text-sm flex-1">{formatted.join(', ')}</span>
                      <span className="text-yellow-700 text-sm font-medium whitespace-nowrap">
                        Tot: {dates.length} {dates.length === 1 ? 'giorno' : 'giorni'}
                      </span>
                    </div>
                  )
                })}
            </div>
          </div>
        )}
      </div>

      {/* Modal indisponibilità dipendente — caricamento diretto dal manager */}
      {dettaglioEmp && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onClick={() => setDettaglioEmp(null)}>
          <div className="bg-white rounded-2xl shadow-xl p-6 max-w-md w-full max-h-[90vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-bold text-gray-800 text-lg">🗓 Indisponibilità — {dettaglioEmp.nome}</h2>
              <button onClick={() => setDettaglioEmp(null)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>

            {isMD && ferieSaldi[dettaglioEmp.id] && (() => {
              const s = ferieSaldi[dettaglioEmp.id]
              return (
                <div className="flex gap-4 mb-4 p-3 bg-gray-50 rounded-lg">
                  <div>
                    <div className="text-xs text-gray-500">Ferie disponibili</div>
                    <div className="font-bold text-green-600">{(s.ferie_giorni_totali - s.ferie_giorni_usati).toFixed(2)} giorni</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-500">Permessi disponibili</div>
                    <div className="font-bold text-blue-600">{(s.permessi_ore_totali - s.permessi_ore_usate).toFixed(2)} ore</div>
                  </div>
                </div>
              )
            })()}

            {!schedule ? (
              <p className="text-gray-500 text-sm">Crea prima il piano del mese per poter registrare le indisponibilità.</p>
            ) : (
              <>
                <p className="text-sm text-gray-600 mb-3">
                  Seleziona i giorni in cui <strong>{dettaglioEmp.nome}</strong> non è disponibile — {MESI[mese - 1]} {anno}.
                </p>

                <div className="grid grid-cols-7 gap-1 text-center text-xs text-gray-400 mb-2">
                  {['L','M','M','G','V','S','D'].map((d, i) => <div key={i}>{d}</div>)}
                </div>
                <ModalCalGrid giorni={giorni} selected={modalSelected} onToggle={toggleModalDate} />

                <div className="mt-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Tipo assenza</label>
                  <select value={modalTipoAssenza}
                    onChange={e => { setModalTipoAssenza(e.target.value); setModalSaved(false) }}
                    className="w-full border rounded-lg px-3 py-2 text-sm">
                    <option value="P">P — Permesso</option>
                    <option value="F">F — Ferie</option>
                    <option value="R">R — Recupero</option>
                    <option value="M">M — Malattia</option>
                    <option value="MT">MT — Maternità</option>
                  </select>
                </div>

                {modalTipoAssenza === 'P' && (
                  <div className="mt-4">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Ore di permesso (lascia vuoto per giornata intera)
                    </label>
                    <input type="number" min="1" max="8" placeholder="es. 2"
                      className="w-full border rounded-lg px-3 py-2 text-sm"
                      value={modalOreParziali}
                      onChange={e => { setModalOreParziali(e.target.value); setModalSaved(false) }} />
                    <p className="text-xs text-gray-400 mt-1">
                      Se specificato, il turno del giorno si accorcia (entra più tardi) invece di sparire —
                      si scalano solo queste ore dal saldo permessi, applicato a tutti i giorni selezionati.
                    </p>
                  </div>
                )}

                <div className="mt-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Motivo (opzionale)</label>
                  <input type="text" placeholder="es. visita medica, impegno familiare..."
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                    value={modalMotivo} onChange={e => { setModalMotivo(e.target.value); setModalSaved(false) }} />
                </div>

                <div className="mt-5">
                  <label className="block text-sm font-medium text-gray-700 mb-2">Storico assenze</label>
                  {loadingStorico ? (
                    <p className="text-xs text-gray-400">Caricamento...</p>
                  ) : storicoAssenze.length === 0 ? (
                    <p className="text-xs text-gray-400">Nessuna assenza registrata.</p>
                  ) : (
                    <div className="overflow-x-auto border rounded-lg max-h-48 overflow-y-auto">
                      <table className="w-full text-xs">
                        <thead className="bg-gray-50 sticky top-0">
                          <tr className="text-left text-gray-500">
                            <th className="px-2 py-1">Data</th>
                            <th className="px-2 py-1">Tipo</th>
                            <th className="px-2 py-1">Motivo</th>
                            <th className="px-2 py-1">Inserito da</th>
                            <th className="px-2 py-1">Data inserimento</th>
                          </tr>
                        </thead>
                        <tbody>
                          {storicoAssenze.map(u => (
                            <tr key={u.id} className="border-t">
                              <td className="px-2 py-1">{u.data}</td>
                              <td className="px-2 py-1">{u.tipo_assenza ?? 'P'}</td>
                              <td className="px-2 py-1">{u.motivo || '—'}</td>
                              <td className="px-2 py-1">{u.inserito_da ?? '—'}</td>
                              <td className="px-2 py-1">{u.created_at ? new Date(u.created_at).toLocaleDateString('it-IT') : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div className="flex gap-3 mt-5">
                  <button onClick={() => setDettaglioEmp(null)}
                    className="flex-1 py-2.5 rounded-lg font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 transition">
                    Chiudi
                  </button>
                  <button onClick={salvaIndisponibilitaModal} disabled={modalSaving}
                    className={`flex-1 py-2.5 rounded-lg font-semibold text-white transition disabled:opacity-50 ${
                      modalSaved ? 'bg-green-500' : 'bg-blue-600 hover:bg-blue-700'
                    }`}>
                    {modalSaving ? 'Salvataggio...' : modalSaved ? '✅ Salvato!' : 'Salva'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <MaiaChatBubble
        isMD={isMD}
        storeNome={storeNome}
        storeId={storeId}
        scheduleId={schedule?.id ?? null}
        employees={employees}
        shifts={shifts}
        giorni={giorni}
        mese={mese}
        anno={anno}
        settimanaInizio={settimanaAttiva?.giorni[0]?.data ?? null}
        settimanaFine={settimanaAttiva?.giorni[settimanaAttiva.giorni.length - 1]?.data ?? null}
      />
    </div>
  )
}

/** Calendario a griglia 7 colonne (Lun-Dom) per il modal indisponibilità del manager. */
function ModalCalGrid({ giorni, selected, onToggle }: {
  giorni: ReturnType<typeof getDays>,
  selected: Set<string>,
  onToggle: (d: string) => void
}) {
  if (!giorni.length) return null
  const firstDay = new Date(giorni[0].data + 'T00:00:00').getDay()
  const offset = firstDay === 0 ? 6 : firstDay - 1

  return (
    <div className="grid grid-cols-7 gap-1">
      {Array(offset).fill(null).map((_, i) => <div key={`e${i}`} />)}
      {giorni.map(g => (
        <button key={g.data} onClick={() => !g.domenica && onToggle(g.data)}
          disabled={g.domenica}
          className={`aspect-square rounded-lg text-sm font-medium transition flex items-center justify-center
            ${g.domenica ? 'text-gray-300 cursor-not-allowed' :
              selected.has(g.data) ? 'bg-red-500 text-white' :
              'hover:bg-gray-100 text-gray-700'}`}>
          {g.num}
        </button>
      ))}
    </div>
  )
}

function getDays(anno: number, mese: number) {
  const days = []
  const d = new Date(anno, mese - 1, 1)
  const GIORNI = ['Dom','Lun','Mar','Mer','Gio','Ven','Sab']
  while (d.getMonth() === mese - 1) {
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    days.push({
      data: `${yyyy}-${mm}-${dd}`,
      num: d.getDate(),
      giorno: GIORNI[d.getDay()],
      domenica: d.getDay() === 0
    })
    d.setDate(d.getDate() + 1)
  }
  return days
}

/** Offset del primo giorno del mese rispetto a Lunedì (0=Lun...6=Dom) — usato per
 * allineare la tabella come un calendario iPhone: celle vuote prima del giorno 1
 * se il mese non inizia di Lunedì. */
function getOffsetLunedi(anno: number, mese: number): number {
  const primoGiorno = new Date(anno, mese - 1, 1).getDay()
  return primoGiorno === 0 ? 6 : primoGiorno - 1
}

/** Settimane reali Lun-Dom del mese (per il PDF settimanale) — sempre a partire dal
 * primo Lunedì del mese, gruppi di 7 giorni consecutivi che finiscono di Domenica. */
function getSettimaneLunDom(giorni: ReturnType<typeof getDays>, mese: number): { label: string; giorni: ReturnType<typeof getDays> }[] {
  const firstMondayIdx = giorni.findIndex(g => new Date(g.data + 'T00:00:00').getDay() === 1)
  const start = firstMondayIdx === -1 ? 0 : firstMondayIdx
  const nomeMese = MESI[mese - 1]
  const settimane: { label: string; giorni: ReturnType<typeof getDays> }[] = []
  for (let i = start; i < giorni.length; i += 7) {
    const chunk = giorni.slice(i, i + 7)
    if (chunk.length === 0) continue
    const primo = chunk[0]
    const ultimo = chunk[chunk.length - 1]
    settimane.push({
      label: `${primo.giorno} ${primo.num} — ${ultimo.giorno} ${ultimo.num} ${nomeMese}`,
      giorni: chunk,
    })
  }
  return settimane
}
