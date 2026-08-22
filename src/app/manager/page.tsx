'use client'
import { useState, useEffect, useRef, Fragment } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { Employee, Schedule, Shift, TurnoTipo, ORARI_TURNO_MD, FerieSaldo } from '@/types'
import MaiaChatBubble from '@/components/MaiaChatBubble'
import { oreFromOrario } from '@/lib/generator'

const MESI = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno',
               'Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre']

// Ordine fisso dipendenti MD Lanciano (non alfabetico).
const ORDINE_MD = [
  'Angelica', 'Damiana', 'Elisa', 'Marilena',
  'Max', 'Romeo', 'Stefania', 'Cristina',
  'Yuri', 'Tony', 'Gilda',
]

function sortEmployees(emps: Employee[]): Employee[] {
  return [...emps].sort((a, b) => {
    const ia = ORDINE_MD.indexOf(a.nome)
    const ib = ORDINE_MD.indexOf(b.nome)
    if (ia === -1 && ib === -1) return a.nome.localeCompare(b.nome)
    if (ia === -1) return 1  // dipendenti non in lista vanno in fondo
    if (ib === -1) return -1
    return ia - ib
  })
}
const TURNO_LABEL: Record<string, string> = {
  mattina: 'M', pomeriggio: 'Pm', full: 'F', riposo: '—', domenica_lungo: 'DL', domenica_corto: 'DC',
  yuri_full: 'YF', yuri_pomeriggio: 'Y', mattina_corta: 'M5', pomeriggio_corto: 'P5',
  turno_breve_11_14: '11/14', turno_breve_12_15: '12/15', turno_breve_13_16: '13/16', turno_breve_17_20: '17/20',
  spezzato_mattina: 'Sp-M', spezzato_pomeriggio: 'Sp-P',
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
  // Turno spezzato — colore distintivo, riconoscibile a colpo d'occhio (8 agosto 2026).
  spezzato_mattina: 'bg-fuchsia-100 text-fuchsia-800',
  spezzato_pomeriggio: 'bg-fuchsia-100 text-fuchsia-800',
}
// Ore lavorate per tipo turno — usato per la colonna TOT settimanale.
const ORE_PER_TURNO: Record<string, number> = {
  mattina: 6, pomeriggio: 6, full: 9,
  mattina_corta: 5, pomeriggio_corto: 5,
  yuri_full: 6, yuri_pomeriggio: 3,
  domenica_lungo: 5, domenica_corto: 3,
  riposo: 0,
  turno_breve_11_14: 3, turno_breve_12_15: 3, turno_breve_13_16: 3, turno_breve_17_20: 3,
  // Fallback mai realmente usato — il turno spezzato ha sempre ora_inizio/ora_fine reali,
  // getOreDisplay le usa sempre in priorità (vedi sotto).
  spezzato_mattina: 0, spezzato_pomeriggio: 0,
}

const ASSENZA_LABEL: Record<string, string> = {
  P: 'Permesso', F: 'Ferie', R: 'Recupero', M: 'Malattia', MT: 'Maternità',
}

// FIX 2 (7 agosto 2026, richiesta Giacomo): il DB continua a salvare "R" per il Recupero
// (tipo_assenza invariato, nessuna migrazione dati necessaria) — ma "R" da sola era
// ambigua con il Riposo normale. La lettera MOSTRATA (tabella, PDF, risposte Maia) ora è
// sempre "REC" per il Recupero. Il Riposo normale non ha mai avuto una lettera (cella
// vuota/turno normale, non un'assenza) — non serve toccarlo.
function getAssenzaDisplay(code: string): string {
  return code === 'R' ? 'REC' : code
}

const ASSENZA_COLOR: Record<string, string> = {
  F: 'bg-yellow-100 text-yellow-800',
  P: 'bg-orange-100 text-orange-800',
  R: 'bg-blue-100 text-blue-800',
  M: 'bg-red-100 text-red-800',
  MT: 'bg-pink-100 text-pink-800',
}

// Orari reali MD Lanciano — mostrati in cella invece delle lettere.
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
function getTurnoDisplay(tipo: string, shift?: { ora_inizio?: string | null; ora_fine?: string | null }): string {
  if (tipo !== 'riposo' && shift?.ora_inizio && shift?.ora_fine) {
    return `${formatOraShort(shift.ora_inizio)}/${formatOraShort(shift.ora_fine)}`
  }
  return TURNO_ORARIO_MD[tipo] ?? TURNO_LABEL[tipo] ?? tipo
}

/** Ore effettive lavorate — calcolate dagli orari reali del turno, non da un lookup fisso,
 * perché con la distribuzione a ore intere le ore variano giorno per giorno. */
function getOreDisplay(tipo: string, shift?: { ora_inizio?: string | null; ora_fine?: string | null }): number {
  if (tipo === 'riposo') return 0
  const fromTimes = oreFromOrario(shift?.ora_inizio, shift?.ora_fine)
  return fromTimes > 0 ? fromTimes : (ORE_PER_TURNO[tipo] ?? 0)
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
  // Settimane a cavallo tra due mesi (25/08/2026): lo schedule del mese precedente/
  // successivo, letti in sola lettura per sapere se esistono già (creati al bisogno solo
  // da generaSettimana/resetSettimana via ensureSchedule, mai qui) — vedi scheduleIdFor.
  const [schedulePrev, setSchedulePrev] = useState<Schedule | null>(null)
  const [scheduleNext, setScheduleNext] = useState<Schedule | null>(null)
  const [shifts, setShifts] = useState<Shift[]>([])
  const [unavailabilities, setUnavailabilities] = useState<Unavailability[]>([])
  // Turni/permessi dei soli giorni di "bordo" (fino a 6 gg finali del mese precedente +
  // fino a 6 gg iniziali del successivo) che possono comparire in una settimana a cavallo
  // con il mese corrente — combinati con shifts/unavailabilities in getShift/hasUnavailability
  // così i pannelli/report settimanali vedono l'intera settimana reale, non solo il mese
  // corrente. La vista mensile normale continua a usare `shifts`/`unavailabilities` da soli
  // via i filtri per data, quindi non è affetta da questa aggiunta.
  const [shiftsBordo, setShiftsBordo] = useState<Shift[]>([])
  const [unavailabilitiesBordo, setUnavailabilitiesBordo] = useState<Unavailability[]>([])
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
  // Turno spezzato manuale (8 agosto 2026) — modal separato dal popup orari normale.
  const [modalSpezzato, setModalSpezzato] = useState<{ empId: string; data: string } | null>(null)
  const [fineMattinaSpezzato, setFineMattinaSpezzato] = useState('11:00')
  const [inizioPomeriggioSpezzato, setInizioPomeriggioSpezzato] = useState('17:00')
  const [savingSpezzato, setSavingSpezzato] = useState(false)
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
  // Settimane a cavallo (25/08/2026): ogni giorno porta anche lo schedule_id risolto
  // (null se lo schedule di quel mese non esiste ancora — verrà creato al bisogno da
  // generaSettimana/resetSettimana tramite ensureSchedule).
  const settimaneMese = getSettimaneLunDomEstese(anno, mese).map(s => ({
    ...s,
    giorni: s.giorni.map(g => ({ ...g, scheduleId: scheduleIdFor(g.mese, g.anno) })),
  }))
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
      setEmployees(sortEmployees(emps || []))

      const { data: festiviData } = await supabase.from('turni_festivi')
        .select('data, nome').eq('store_id', storeId!)
      setFestiviMap(Object.fromEntries((festiviData || []).map((f: any) => [f.data, f.nome])))

      if (emps && emps.length > 0) {
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

      // Settimane a cavallo (25/08/2026): schedule dei mesi adiacenti, in sola lettura —
      // se non esistono ancora (mai creato "Crea piano mese" per quel mese) restano null,
      // verranno creati al bisogno solo quando si genera/resetta davvero una settimana che
      // li tocca (ensureSchedule), mai qui.
      const { mese: prevMese, anno: prevAnno } = meseAdiacente(mese, anno, -1)
      const { mese: nextMese, anno: nextAnno } = meseAdiacente(mese, anno, 1)
      const [{ data: schedPrev }, { data: schedNext }] = await Promise.all([
        supabase.from('schedules').select('*').eq('store_id', storeId!).eq('mese', prevMese).eq('anno', prevAnno).maybeSingle(),
        supabase.from('schedules').select('*').eq('store_id', storeId!).eq('mese', nextMese).eq('anno', nextAnno).maybeSingle(),
      ])
      setSchedulePrev(schedPrev)
      setScheduleNext(schedNext)

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

      // Solo i giorni di bordo (fino a 6 finali del mese prima / 6 iniziali del dopo) che
      // possono ricadere in una settimana a cavallo — non l'intero mese adiacente, per non
      // appesantire il caricamento.
      const bordoPrevRange = schedPrev ? giorniBordo(prevAnno, prevMese, 'coda') : null
      const bordoNextRange = schedNext ? giorniBordo(nextAnno, nextMese, 'testa') : null
      const [shBordoPrev, shBordoNext, unavBordoPrev, unavBordoNext] = await Promise.all([
        bordoPrevRange ? supabase.from('shifts').select('*').eq('schedule_id', schedPrev!.id).gte('data', bordoPrevRange.inizio).lte('data', bordoPrevRange.fine) : Promise.resolve({ data: [] as Shift[] }),
        bordoNextRange ? supabase.from('shifts').select('*').eq('schedule_id', schedNext!.id).gte('data', bordoNextRange.inizio).lte('data', bordoNextRange.fine) : Promise.resolve({ data: [] as Shift[] }),
        bordoPrevRange ? supabase.from('unavailabilities').select('*').eq('schedule_id', schedPrev!.id).gte('data', bordoPrevRange.inizio).lte('data', bordoPrevRange.fine) : Promise.resolve({ data: [] as Unavailability[] }),
        bordoNextRange ? supabase.from('unavailabilities').select('*').eq('schedule_id', schedNext!.id).gte('data', bordoNextRange.inizio).lte('data', bordoNextRange.fine) : Promise.resolve({ data: [] as Unavailability[] }),
      ])
      setShiftsBordo([...(shBordoPrev.data || []), ...(shBordoNext.data || [])])
      setUnavailabilitiesBordo([...(unavBordoPrev.data || []), ...(unavBordoNext.data || [])])
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

  /** Get-or-create per lo schedule di un mese/anno qualsiasi (25/08/2026, settimane a
   * cavallo) — a differenza di createSchedule (sempre sul mese correntemente in state,
   * usato dal bottone "Crea piano mese"), questa serve a generaSettimana/resetSettimana
   * per garantire che esista lo schedule del mese ADIACENTE quando la settimana attiva lo
   * tocca, senza richiedere a Giacomo di crearlo manualmente prima. Non aggiorna lo state
   * schedule/schedulePrev/scheduleNext — il chiamante fa sempre loadData() dopo, che li
   * ricarica tutti da zero. */
  async function ensureSchedule(m: number, a: number): Promise<Schedule> {
    const { data: existing } = await supabase.from('schedules')
      .select('*').eq('store_id', storeId!).eq('mese', m).eq('anno', a).maybeSingle()
    if (existing) return existing
    const { data: created, error } = await supabase.from('schedules')
      .insert({ store_id: storeId!, mese: m, anno: a, stato: 'bozza' }).select().single()
    if (error || !created) throw new Error(`Impossibile creare lo schedule per ${MESI[m - 1]} ${a}: ${error?.message ?? 'errore sconosciuto'}`)
    return created
  }

  /** Risolve lo schedule_id per un giorno di {mese, anno} qualsiasi rispetto al mese
   * correntemente aperto (mese/anno in state) — usa schedule/schedulePrev/scheduleNext,
   * null se quel mese non ha ancora uno schedule creato. */
  function scheduleIdFor(gMese: number, gAnno: number): string | null {
    if (gMese === mese && gAnno === anno) return schedule?.id ?? null
    const prev = meseAdiacente(mese, anno, -1)
    if (gMese === prev.mese && gAnno === prev.anno) return schedulePrev?.id ?? null
    const next = meseAdiacente(mese, anno, 1)
    if (gMese === next.mese && gAnno === next.anno) return scheduleNext?.id ?? null
    return null
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
    if (!settimanaAttiva) return
    const giorniLunSab = settimanaAttiva.giorni.filter(g => !g.domenica)
    if (giorniLunSab.length === 0) return

    setLoading(true)
    try {
      // Settimane a cavallo (25/08/2026): garantisce che esista lo schedule per OGNI mese
      // toccato dalla settimana (di solito 1, a volte 2) — lo crea automaticamente se manca,
      // invece di richiedere il click manuale su "Crea piano mese" per il mese adiacente.
      const mesiCoinvolti = Array.from(new Set(giorniLunSab.map(g => `${g.anno}-${g.mese}`)))
        .map(k => { const [a, m] = k.split('-').map(Number); return { anno: a, mese: m } })
      const schedulePerChiave: Record<string, Schedule> = {}
      for (const { anno: a, mese: m } of mesiCoinvolti) {
        schedulePerChiave[`${a}-${m}`] = await ensureSchedule(m, a)
      }
      const giorniConSchedule = giorniLunSab.map(g => ({
        data: g.data,
        schedule_id: schedulePerChiave[`${g.anno}-${g.mese}`].id,
      }))

      const res = await fetch('/api/shifts/generate-week', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ giorni: giorniConSchedule }),
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
    } catch (e: any) {
      setError(`Errore generazione settimana: ${e?.message ?? String(e)}`)
    }
    await loadData()
    setLoading(false)
  }

  async function resetSettimana() {
    if (!settimanaAttiva) return
    if (!window.confirm(`Cancellare turni e permessi della settimana ${settimanaAttiva.label}?`)) return

    setLoading(true)
    // Settimane a cavallo (25/08/2026): raggruppa i giorni per schedule_id — una settimana
    // può toccare fino a 2 schedule diversi (uno per mese), ognuno va ripulito separatamente
    // sul proprio intervallo di date reali, altrimenti i giorni dell'altro mese non
    // verrebbero mai cancellati (o peggio, verrebbero cancellati sotto lo schedule_id
    // sbagliato). I giorni il cui mese non ha ancora nessuno schedule vengono ignorati —
    // non c'è nulla da cancellare per un mese mai generato.
    const perSchedule = new Map<string, string[]>()
    for (const g of settimanaAttiva.giorni) {
      if (!g.scheduleId) continue
      const arr = perSchedule.get(g.scheduleId) ?? []
      arr.push(g.data)
      perSchedule.set(g.scheduleId, arr)
    }
    for (const [schedId, date] of Array.from(perSchedule)) {
      const inizio = date[0]
      const fine = date[date.length - 1]
      await supabase.from('shifts').delete().eq('schedule_id', schedId).gte('data', inizio).lte('data', fine)
      await supabase.from('unavailabilities').delete().eq('schedule_id', schedId).gte('data', inizio).lte('data', fine)
    }
    await loadData()
    setLoading(false)
  }

  function controllaTurni() {
    const settimane = getSettimaneLunDomEstese(anno, mese)

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
        // Mese REALE del giorno, non quello aperto in UI (25/08/2026, settimane a cavallo)
        // — un turno del 31 Agosto va etichettato "Agosto", non "Settembre".
        .map(({ g, shift }) => `${g.giorno} ${g.num} ${MESI[g.mese - 1]}: ${getTurnoDisplay(shift!.tipo, shift!)}`)
        .join(', ')
      return `- ${emp.nome} (${emp.ore_settimanali}h contratto): ${oreTot}h assegnate${dettaglio ? ' — ' + dettaglio : ''}`
    }).join('\n')

    const domenicheTesto = domeniche.map(g => {
      const lavoranti = employees
        .map(emp => ({ emp, shift: getShift(emp.id, g.data) }))
        .filter(({ shift }) => shift && shift.tipo !== 'riposo')
      const elenco = lavoranti.map(({ emp, shift }) => `${emp.nome} (${getTurnoDisplay(shift!.tipo, shift!)})`).join(', ')
      return `- ${g.num} ${MESI[g.mese - 1]}: ${elenco || 'nessuno assegnato'}`
    }).join('\n')

    const primo = settimanaAttiva.giorni[0]
    const ultimo = settimanaAttiva.giorni[settimanaAttiva.giorni.length - 1]
    // Se la settimana attraversa due mesi, entrambi vanno indicati esplicitamente.
    const etichettaMese = primo.mese !== ultimo.mese ? `${MESI[primo.mese - 1]} — ${MESI[ultimo.mese - 1]}` : MESI[primo.mese - 1]

    const contestoSettimana = `
Stiamo lavorando sulla settimana ${primo.giorno} ${primo.num} — ${ultimo.giorno} ${ultimo.num} ${etichettaMese}.

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
    // Se il giorno è spezzato (2 righe), ritorna sempre il blocco mattina (sequenza 1) —
    // tutti i chiamanti esistenti si aspettano un singolo turno, comportamento invariato
    // per i giorni normali (sequenza sempre 1 di default). Per i giorni spezzati, la
    // visualizzazione a due blocchi usa getShiftsForDay() sotto, non questa funzione.
    // Include shiftsBordo (25/08/2026, settimane a cavallo) — sicuro anche per la vista
    // mensile normale: le date di bordo appartengono sempre a un mese diverso da quello
    // corrente, quindi non collidono mai con le date filtrate qui.
    return [...shifts, ...shiftsBordo]
      .filter(s => s.employee_id === empId && s.data === data)
      .sort((a, b) => (a.sequenza ?? 1) - (b.sequenza ?? 1))[0]
  }

  /** Tutti gli shift di un dipendente per un giorno, ordinati per sequenza — normalmente
   * 1 solo elemento, 2 per un giorno con turno spezzato (8 agosto 2026). */
  function getShiftsForDay(empId: string, data: string) {
    return [...shifts, ...shiftsBordo]
      .filter(s => s.employee_id === empId && s.data === data)
      .sort((a, b) => (a.sequenza ?? 1) - (b.sequenza ?? 1))
  }

  async function cancellaEmployee(emp: Employee) {
    await supabase.from('employees').update({ attivo: false }).eq('id', emp.id)
    setEmployees(prev => prev.filter(e => e.id !== emp.id))
    setCestino(prev => [...prev, emp])
  }

  async function ripristinaEmployee(emp: Employee) {
    await supabase.from('employees').update({ attivo: true }).eq('id', emp.id)
    setCestino(prev => prev.filter(e => e.id !== emp.id))
    setEmployees(prev => sortEmployees([...prev, emp]))
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
      if (g.domenica) headRow.push('TOT')
    })
    const head = [headRow]

    const body = employees.map(emp => {
      const row: string[] = [emp.nome]
      giorniDaEsportare.forEach(g => {
        if (festiviMap[g.data]) {
          row.push('FEST')
        } else if (hasUnavailability(emp.id, g.data)) {
          row.push(getAssenzaDisplay(getAssenzaCode(emp.id, g.data)))
        } else {
          // Turno spezzato (8 agosto 2026, STEP 6) — 2 righe nella stessa cella PDF,
          // stesso formato a due righe della UI (\n = seconda riga in autoTable).
          const shiftsGiorno = getShiftsForDay(emp.id, g.data)
          if (shiftsGiorno.length === 2) {
            const [blMattina, blPomeriggio] = shiftsGiorno
            row.push(
              `${getOreDisplay(blMattina.tipo, blMattina)}h ${getTurnoDisplay(blMattina.tipo, blMattina)}\n` +
              `${getOreDisplay(blPomeriggio.tipo, blPomeriggio)}h ${getTurnoDisplay(blPomeriggio.tipo, blPomeriggio)}`
            )
          } else {
            const shift = getShift(emp.id, g.data)
            row.push(getTurnoDisplay(shift?.tipo || 'riposo', shift))
          }
        }
        if (g.domenica) {
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
          // Turno spezzato (8 agosto 2026) — cella a due righe ("Xh oo/oo\nYh oo/oo"),
          // stesso fucsia della UI (bg-fuchsia-100).
          if (val.includes('\n')) { data.cell.styles.fillColor = [250, 232, 255]; return }
          // Assenze — sempre lettera.
          if (['P', 'F', 'R', 'MT'].includes(val)) { data.cell.styles.fillColor = [254, 243, 199]; return }
          // 'M' = assenza "Malattia" — coloriamo come assenza (rosso).
          if (val === 'M') { data.cell.styles.fillColor = [254, 226, 226]; return }

          // Colonna TOT (es. "22h") — verde/rosso in base allo scarto dal contratto settimanale
          const totMatch = val.match(/^(\d+)h$/)
          if (totMatch) {
            const tot = parseInt(totMatch[1], 10)
            const emp = employees[data.row.index]
            if (emp) {
              const diff = Math.abs(tot - emp.ore_settimanali)
              data.cell.styles.fillColor = diff <= 1 ? [220, 252, 231] : [254, 226, 226]
            }
            return
          }

          // Turni — celle mostrano orari reali (es. "8/14").
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
          const color = colorMD[val]
          if (color) data.cell.styles.fillColor = color
        }
      }
    })

    const suffix = subtitle ? `-${subtitle.toLowerCase().replace(/\s+/g, '')}` : ''
    doc.save(`turni-${nomeMese.toLowerCase()}-${anno}${suffix}.pdf`)
  }

  async function exportPDFSettimana() {
    const settimane = getSettimaneLunDomEstese(anno, mese)
    if (settimane.length === 0) { alert('Nessuna settimana disponibile per questo mese.'); return }
    const elenco = settimane.map((s, i) => `${i + 1}: ${s.label}`).join('\n')
    const input = window.prompt(`Quale settimana vuoi esportare?\n${elenco}`)
    const idx = parseInt(input ?? '', 10)
    if (!idx || idx < 1 || idx > settimane.length) return
    const settimana = settimane[idx - 1]
    await exportPDF(settimana.giorni, `Settimana ${idx}`)
  }

  function hasUnavailability(empId: string, data: string) {
    // Include unavailabilitiesBordo (25/08/2026, settimane a cavallo) — vedi commento su getShift.
    return [...unavailabilities, ...unavailabilitiesBordo].some(u => u.employee_id === empId && u.data === data)
  }

  // Tipo di assenza — colonna reale `tipo_assenza` (default 'P').
  const ASSENZA_CYCLE = ['P', 'F', 'R', 'M', 'MT'] as const

  function getAssenzaCode(empId: string, data: string): string {
    const u = [...unavailabilities, ...unavailabilitiesBordo].find(x => x.employee_id === empId && x.data === data)
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

  // ── Colonna TOT settimanale ──────────────────────────────────────────────
  // La colonna TOT va inserita dopo OGNI domenica reale (g.domenica), non dopo
  // giorni fissi 7/14/21/28 — un mese non inizia sempre di lunedì, quindi quei
  // numeri fissi disallineavano il raggruppamento rispetto alle settimane ISO
  // usate dall'algoritmo in generator.ts (che è invece corretto).

  function oreLavorateGiorno(empId: string, data: string): number {
    const u = [...unavailabilities, ...unavailabilitiesBordo].find(x => x.employee_id === empId && x.data === data)
    // Permesso a ore: il turno è accorciato, non azzerato — conta le ore effettivamente lavorate.
    if (u && !u.ore_parziali) return 0 // assenza a giornata intera = 0h lavorate
    // Turno spezzato (8 agosto 2026): un giorno può avere 2 righe (mattina+pomeriggio,
    // sequenza 1/2) — somma le ore di ENTRAMBI i blocchi, non solo il primo. Per un
    // giorno normale getShiftsForDay ritorna sempre 1 solo elemento, comportamento
    // identico a prima (getOreDisplay su un singolo shift).
    const shiftsGiorno = getShiftsForDay(empId, data)
    if (shiftsGiorno.length === 0) return getOreDisplay('riposo')
    return shiftsGiorno.reduce((sum, s) => sum + getOreDisplay(s.tipo, s), 0)
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
   * giorni feriali rimanenti (vedi distribuisciOre in generator.ts) — ma un festivo di
   * SABATO sì, perché il sabato non fa parte di quella redistribuzione dinamica (per lui
   * come per tutti gli altri). */
  function targetSettimana(emp: Employee, sundayData: string): number {
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

    if (res.ok && (deltaFerieGiorni !== 0 || deltaPermessiOre !== 0)) {
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

  // FIX 3 (7 agosto 2026, richiesta Giacomo): lista UNICA e completa di orari per la
  // selezione manuale dal menu a cascata, uguale per TUTTI i dipendenti MD — prima era
  // filtrata per contratto (oreSettimanali), il che impediva a Giacomo di scegliere
  // manualmente un orario "fuori contratto" per gestire un'emergenza. I vincoli per
  // contratto restano validi SOLO per la generazione automatica (generator.ts), MAI per
  // questa selezione manuale. Ordinata cronologicamente per inizio poi fine.
  const TUTTI_GLI_ORARI = [
    '08/11', '08/12', '08/13', '08/14', '08/15', '08/16', '08/20',
    '09/12', '09/13', '09/14', '09/17',
    '10/13', '10/14', '10/15', '10/16', '10/18',
    '11/14', '11/15', '11/16', '11/17',
    '12/15', '12/16',
    '13/16', '13/17',
    '14/19', '14/20',
    '15/20',
    '16/20',
    '17/20',
  ]

  /** Orari validi per il popup cella — stessa lista completa per tutti i dipendenti,
   * indipendentemente dal contratto (vedi nota FIX 3 sopra). Il parametro oreSettimanali
   * non è più usato per filtrare, ma resta nella firma per non toccare il call site. */
  function getOrariValidi(_oreSettimanali: number): string[] {
    return ['—', ...TUTTI_GLI_ORARI]
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
    const shiftsGiorno = getShiftsForDay(empId, data)
    const existing = shiftsGiorno[0]

    // Se il giorno era spezzato (2 righe) e si seleziona un orario NORMALE dal popup,
    // torna a un turno singolo — rimuove il secondo blocco (sequenza 2), 8 agosto 2026.
    if (shiftsGiorno.length > 1) {
      const extra = shiftsGiorno.slice(1)
      setShifts(prev => prev.filter(s => !extra.some(e => e.id === s.id)))
      await supabase.from('shifts').delete().in('id', extra.map(s => s.id))
    }

    if (existing) {
      setShifts(prev => prev.map(s => s.id === existing.id ? { ...s, tipo, ora_inizio: ora_inizio ?? undefined, ora_fine: ora_fine ?? undefined, sequenza: 1 } : s))
      await supabase.from('shifts').update({ tipo, ora_inizio, ora_fine, sequenza: 1 }).eq('id', existing.id)
    } else {
      const optimistic: Shift = {
        id: `temp-${empId}-${data}`,
        schedule_id: schedule.id,
        employee_id: empId,
        data,
        tipo,
        ora_inizio: ora_inizio ?? undefined,
        ora_fine: ora_fine ?? undefined,
        sequenza: 1,
      }
      setShifts(prev => [...prev, optimistic])
      const { data: newShift } = await supabase.from('shifts')
        .insert({ schedule_id: schedule.id, employee_id: empId, data, tipo, ora_inizio, ora_fine, sequenza: 1 })
        .select().single()
      if (newShift) {
        setShifts(prev => prev.map(s => s.id === `temp-${empId}-${data}` ? newShift : s))
      }
    }
    setPopupCell(null)
  }

  /** Turno spezzato manuale (8 agosto 2026, richiesta Giacomo — caso raro/eccezionale,
   * SOLO manuale via questo modal, MAI dal generatore automatico né da Maia).
   * Mattina sempre 08:00-fineMattina, pomeriggio sempre inizioPomeriggio-20:00 — due
   * righe distinte (sequenza 1/2) sostituiscono qualsiasi turno singolo esistente quel
   * giorno. */
  async function salvaTurnoSpezzato(empId: string, data: string, fineMattina: string, inizioPomeriggio: string) {
    if (!schedule) return
    setSavingSpezzato(true)
    try {
      const esistenti = getShiftsForDay(empId, data)
      if (esistenti.length > 0) {
        await supabase.from('shifts').delete().in('id', esistenti.map(s => s.id))
      }
      const righe = [
        { schedule_id: schedule.id, employee_id: empId, data, tipo: 'spezzato_mattina' as TurnoTipo, ora_inizio: '08:00', ora_fine: fineMattina, sequenza: 1 },
        { schedule_id: schedule.id, employee_id: empId, data, tipo: 'spezzato_pomeriggio' as TurnoTipo, ora_inizio: inizioPomeriggio, ora_fine: '20:00', sequenza: 2 },
      ]
      const { data: nuovi } = await supabase.from('shifts').insert(righe).select()
      setShifts(prev => {
        const senzaEsistenti = prev.filter(s => !esistenti.some(e => e.id === s.id))
        return nuovi ? [...senzaEsistenti, ...nuovi] : senzaEsistenti
      })
    } finally {
      setSavingSpezzato(false)
      setModalSpezzato(null)
      setPopupCell(null)
    }
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

          {schedule && (
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
          {settimanaAttiva && (
            <button onClick={generaSettimana} disabled={loading}
              className="bg-purple-600 text-white px-4 py-2 rounded hover:bg-purple-700 disabled:opacity-50">
              {loading ? 'Generando...' : '⚡ Genera settimana'}
            </button>
          )}
          {settimanaAttiva && (
            <button onClick={resetSettimana} disabled={loading}
              className="bg-red-100 text-red-600 px-4 py-2 rounded hover:bg-red-200 border border-red-200 disabled:opacity-50">
              🗑️ Reset settimana
            </button>
          )}
          {settimanaAttiva && (
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
              {shifts.length > 0 && (
                <button onClick={controllaTurni}
                  className="bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700 flex items-center gap-2">
                  🔍 Controlla turni
                </button>
              )}
              {shifts.length > 0 && (
                <button onClick={() => { setSettimanaChiusure(0); setShowChiusure(true) }}
                  className="bg-slate-700 text-white px-4 py-2 rounded hover:bg-slate-800 flex items-center gap-2">
                  🔒 Chiusure
                </button>
              )}
              {shifts.length > 0 && (
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
                <option value={22}>22h/sett</option>
                <option value={28}>28h/sett</option>
                <option value={30}>30h/sett</option>
                <option value={35}>35h/sett</option>
                <option value={36}>36h/sett</option>
                <option value={46}>46h/sett</option>
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
        {shifts.length > 0 && employees.filter(emp => {
          const settimane = getSettimaneLunDomEstese(anno, mese)
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
                    <th key={`empty-h-${i}`} className="p-2 text-center min-w-14 bg-gray-50 border-b">
                      <div className={`text-xs ${i >= 5 ? 'text-red-300' : 'text-gray-300'}`}>
                        {['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'][i]}
                      </div>
                    </th>
                  ))}
                  {giorniOrdinati.map(g => {
                    const inSettimanaAttiva = !!settimanaAttiva && settimanaAttiva.giorni.some(sg => sg.data === g.data)
                    const nomeFestivo = festiviMap[g.data]
                    return (
                      <Fragment key={g.data}>
                        <th className={`p-2 text-center font-medium min-w-14 ${g.domenica || nomeFestivo ? 'bg-red-50 text-red-400' : 'text-gray-600'} ${inSettimanaAttiva ? 'border-t-2 border-b-2 border-blue-500' : ''}`}>
                          <div className="text-xs">{g.giorno}</div>
                          <div className="text-xs text-gray-400">{g.num}</div>
                          {nomeFestivo && <div className="text-xs text-purple-500">{nomeFestivo}</div>}
                        </th>
                        {g.domenica && (
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
                          {emp.ore_settimanali}h{emp.ruolo ? ` • ${emp.ruolo === 'cassiere' ? 'cassiere' : 'non cassiere'}` : ''}
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
                      const nomeFestivo = festiviMap[g.data]
                      const domenicaBloccata = !!nomeFestivo
                      const cellBg = g.domenica || nomeFestivo ? 'bg-purple-50' : ''
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
                              {getAssenzaDisplay(assenzaCode)}
                            </button>
                          </td>
                        )
                      })() : (() => {
                        // Turno spezzato (8 agosto 2026) — 2 righe per lo stesso giorno
                        // (sequenza 1=mattina, 2=pomeriggio): mostrale impilate invece del
                        // singolo turno normale, colore distintivo fucsia per riconoscerle
                        // a colpo d'occhio.
                        const shiftsGiorno = getShiftsForDay(emp.id, g.data)
                        if (shiftsGiorno.length === 2) {
                          const [blMattina, blPomeriggio] = shiftsGiorno
                          return (
                            <td className={`p-1 text-center ${cellBg} ${bordoSettimana}`}>
                              <button
                                onClick={(e) => {
                                  if (domenicaBloccata) return
                                  const rect = e.currentTarget.getBoundingClientRect()
                                  setPopupCell({ empId: emp.id, data: g.data, x: rect.left, y: rect.bottom })
                                }}
                                disabled={domenicaBloccata}
                                title="Turno spezzato — click per modificare"
                                className="inline-block px-1 py-0.5 rounded hover:opacity-80 disabled:cursor-not-allowed whitespace-nowrap bg-fuchsia-100 text-fuchsia-800">
                                <div className="flex flex-col items-center leading-tight text-xs">
                                  <div className="font-medium">{getOreDisplay(blMattina.tipo, blMattina)}h {getTurnoDisplay(blMattina.tipo, blMattina)}</div>
                                  <div className="border-t border-fuchsia-300 w-full my-0.5" />
                                  <div className="font-medium">{getOreDisplay(blPomeriggio.tipo, blPomeriggio)}h {getTurnoDisplay(blPomeriggio.tipo, blPomeriggio)}</div>
                                </div>
                              </button>
                            </td>
                          )
                        }
                        return (
                          <td className={`p-1 text-center ${cellBg} ${bordoSettimana}`}>
                            <button
                              onClick={(e) => {
                                if (domenicaBloccata) return
                                const rect = e.currentTarget.getBoundingClientRect()
                                setPopupCell({ empId: emp.id, data: g.data, x: rect.left, y: rect.bottom })
                              }}
                              disabled={domenicaBloccata}
                              title={`Click per scegliere orario (attuale: ${tipo})`}
                              className={`inline-block px-1 py-0.5 rounded hover:opacity-80 disabled:cursor-not-allowed whitespace-nowrap ${TURNO_COLOR[tipo]}`}>
                              {tipo !== 'riposo' ? (
                                <div className="flex flex-col items-center leading-tight">
                                  <span className="text-xs font-bold text-gray-500">{getOreDisplay(tipo, shift)}h</span>
                                  <span className="text-xs font-medium">{getTurnoDisplay(tipo, shift)}</span>
                                </div>
                              ) : (
                                <span className="text-xs font-bold">{getTurnoDisplay(tipo, shift)}</span>
                              )}
                            </button>
                          </td>
                        )
                      })()

                      const showTot = g.domenica
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
              {/* Le celle mostrano già gli orari — nessuna voce turno in legenda, solo assenze. */}
              <span className="text-pink-700">11/14, 12/15, 13/16, 17/20 = Turno breve (3h)</span>
              <span className="text-fuchsia-700">✂️ = Turno spezzato (mattina 08:00-x + pomeriggio x-20:00)</span>
              <span><strong className="text-yellow-700">F</strong><span className="text-yellow-700"> = Ferie</span></span>
              <span><strong className="text-yellow-700">P</strong><span className="text-yellow-700"> = Permesso</span></span>
              <span><strong className="text-yellow-700">REC</strong><span className="text-yellow-700"> = Recupero</span></span>
              <span><strong className="text-red-700">M</strong><span className="text-red-700"> = Malattia</span></span>
              <span><strong className="text-yellow-700">MT</strong><span className="text-yellow-700"> = Maternità</span></span>
            </div>
          </div>
        )}

        {/* Popup orari validi — rispetta i limiti ore contratto */}
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
                <button onClick={() => { setModalSpezzato({ empId: popupCell.empId, data: popupCell.data }); setPopupCell(null) }}
                  className="block w-full text-left px-3 py-1 hover:bg-fuchsia-50 text-sm rounded border-t mt-1 pt-2 text-fuchsia-700 whitespace-nowrap">
                  ✂️ Dividi turno (mattina + pomeriggio)
                </button>
              </div>
            </>
          )
        })()}

        {/* Modal "Dividi turno" — turno spezzato manuale, caso raro/eccezionale, SOLO
            manuale (mai generatore automatico né Maia), 8 agosto 2026. */}
        {modalSpezzato && (() => {
          const emp = employees.find(e => e.id === modalSpezzato.empId)
          if (!emp) return null
          const oreMattina = parseInt(fineMattinaSpezzato.split(':')[0], 10) - 8
          const orePomeriggio = 20 - parseInt(inizioPomeriggioSpezzato.split(':')[0], 10)
          const oreTotali = oreMattina + orePomeriggio
          return (
            <>
              <div className="fixed inset-0 bg-black/30 z-[999]" onClick={() => setModalSpezzato(null)} />
              <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-xl p-5 z-[1000] w-80">
                <h3 className="font-semibold text-sm mb-1">✂️ Dividi turno — {emp.nome}</h3>
                <p className="text-xs text-gray-500 mb-3">{modalSpezzato.data}</p>

                <label className="block text-xs font-medium text-gray-700 mb-1">Blocco mattina (inizia sempre alle 08:00)</label>
                <select value={fineMattinaSpezzato} onChange={e => setFineMattinaSpezzato(e.target.value)}
                  className="w-full border rounded px-2 py-1 text-sm mb-3">
                  <option value="09:00">08/09 (1h)</option>
                  <option value="10:00">08/10 (2h)</option>
                  <option value="11:00">08/11 (3h)</option>
                  <option value="12:00">08/12 (4h)</option>
                  <option value="13:00">08/13 (5h)</option>
                </select>

                <label className="block text-xs font-medium text-gray-700 mb-1">Blocco pomeriggio (finisce sempre alle 20:00)</label>
                <select value={inizioPomeriggioSpezzato} onChange={e => setInizioPomeriggioSpezzato(e.target.value)}
                  className="w-full border rounded px-2 py-1 text-sm mb-3">
                  <option value="15:00">15/20 (5h)</option>
                  <option value="16:00">16/20 (4h)</option>
                  <option value="17:00">17/20 (3h)</option>
                  <option value="18:00">18/20 (2h)</option>
                  <option value="19:00">19/20 (1h)</option>
                </select>

                <div className="text-sm font-medium text-fuchsia-700 mb-3">Totale: {oreTotali}h</div>

                <div className="flex gap-2">
                  <button onClick={() => setModalSpezzato(null)}
                    className="flex-1 border rounded px-3 py-1.5 text-sm hover:bg-gray-50">Annulla</button>
                  <button disabled={savingSpezzato}
                    onClick={() => salvaTurnoSpezzato(modalSpezzato.empId, modalSpezzato.data, fineMattinaSpezzato, inizioPomeriggioSpezzato)}
                    className="flex-1 bg-fuchsia-600 text-white rounded px-3 py-1.5 text-sm hover:bg-fuchsia-700 disabled:opacity-50">
                    {savingSpezzato ? 'Salvo...' : 'Salva'}
                  </button>
                </div>
              </div>
            </>
          )
        })()}

        {/* Pannello laterale "Chiusure" — copertura chiusura 20:00 per settimana (Lun-Sab) */}
        {showChiusure && (() => {
          const settimane = getSettimaneLunDomEstese(anno, mese)
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
                        <div className="text-sm font-semibold text-gray-800 mb-1">{g.giorno === 'Sab' ? 'Sabato' : ['Lun','Mar','Mer','Gio','Ven'].includes(g.giorno) ? { Lun: 'Lunedì', Mar: 'Martedì', Mer: 'Mercoledì', Gio: 'Giovedì', Ven: 'Venerdì' }[g.giorno] : g.giorno} {g.num} {MESI[g.mese - 1]}</div>
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
        {showMezzogiorno && (() => {
          const settimane = getSettimaneLunDomEstese(anno, mese)
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
                        <div className="text-sm font-semibold text-gray-800 mb-1">{g.giorno === 'Sab' ? 'Sabato' : ['Lun','Mar','Mer','Gio','Ven'].includes(g.giorno) ? { Lun: 'Lunedì', Mar: 'Martedì', Mer: 'Mercoledì', Gio: 'Giovedì', Ven: 'Venerdì' }[g.giorno] : g.giorno} {g.num} {MESI[g.mese - 1]}</div>
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

            {ferieSaldi[dettaglioEmp.id] && (() => {
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
                    <option value="R">REC — Recupero</option>
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

/** Mese/anno a distanza di `delta` mesi (±1) da (mese, anno) — gestisce il cambio anno. */
function meseAdiacente(mese: number, anno: number, delta: -1 | 1): { mese: number; anno: number } {
  if (delta === -1) return mese === 1 ? { mese: 12, anno: anno - 1 } : { mese: mese - 1, anno }
  return mese === 12 ? { mese: 1, anno: anno + 1 } : { mese: mese + 1, anno }
}

/** Fino a 6 giorni di "bordo" di un mese — la 'coda' (ultimi giorni, per estendere il
 * mese SUCCESSIVO all'indietro) o la 'testa' (primi giorni, per estendere il mese
 * PRECEDENTE in avanti). 6 giorni bastano sempre a coprire l'eventuale settimana a
 * cavallo, qualunque sia il giorno della settimana in cui cade il confine tra i mesi. */
function giorniBordo(anno: number, mese: number, parte: 'coda' | 'testa'): { inizio: string; fine: string } {
  const giorni = getDays(anno, mese)
  const slice = parte === 'coda' ? giorni.slice(-6) : giorni.slice(0, 6)
  return { inizio: slice[0].data, fine: slice[slice.length - 1].data }
}

/** Calendario esteso attorno al mese (mese, anno): i suoi giorni + fino a 6 giorni finali
 * del mese precedente + fino a 6 giorni iniziali del successivo — ogni giorno porta il
 * proprio {mese, anno} reale, perché una settimana costruita su questo calendario può
 * contenere giorni di schedule_id diversi. */
function getGiorniEstesi(anno: number, mese: number) {
  const prev = meseAdiacente(mese, anno, -1)
  const next = meseAdiacente(mese, anno, 1)
  const correnti = getDays(anno, mese).map(g => ({ ...g, mese, anno }))
  const prevTail = getDays(prev.anno, prev.mese).slice(-6).map(g => ({ ...g, mese: prev.mese, anno: prev.anno }))
  const nextHead = getDays(next.anno, next.mese).slice(0, 6).map(g => ({ ...g, mese: next.mese, anno: next.anno }))
  return [...prevTail, ...correnti, ...nextHead]
}

/** Settimane Lun-Dom VERE del mese, comprese quelle a cavallo con il mese precedente/
 * successivo — 25/08/2026, correzione del fix del 22/08/2026 (vedi CLAUDE.md, sezione
 * "prima settimana di Settembre").
 *
 * Il fix del 22/08 si limitava a includere il frammento iniziale/finale come voce
 * SEPARATA, sempre dentro un solo mese/schedule_id (es. "Lun31 Agosto" da 1 solo giorno
 * nel selettore di Agosto, "Mar1-Dom6 Settembre" da 6 giorni nel selettore di Settembre)
 * — Giacomo ha segnalato che questo lascia il 31 agosto come giorno "fantasma", non
 * gestibile insieme al resto della settimana di lavoro di Settembre.
 *
 * Questa versione costruisce le settimane su un calendario ESTESO (getGiorniEstesi:
 * fino a 6 giorni del mese prima + fino a 6 del mese dopo), così una settimana come
 * Lun31Ago—Dom6Set appare come UNA SOLA voce di 7 giorni reali. Ogni giorno porta il
 * proprio {mese, anno} — spetta ai chiamanti (generaSettimana, resetSettimana, pannelli,
 * Maia) risolvere il relativo schedule_id per giorno (scheduleIdFor nel componente),
 * dato che una stessa settimana può avere giorni di due schedule_id diversi.
 *
 * Le settimane che non toccano il mese richiesto vengono scartate (evita che il
 * selettore di Settembre mostri anche una settimana che sta interamente in Agosto, già
 * visibile nel selettore di Agosto) — ma una settimana a cavallo COMPARE in entrambi i
 * selettori (Agosto e Settembre), perché tocca davvero entrambi i mesi: è previsto e
 * corretto (il 31 agosto resta comunque visibile/modificabile anche dalla vista mensile
 * di Agosto, oltre che da questa settimana a cavallo). */
function getSettimaneLunDomEstese(anno: number, mese: number) {
  const estesi = getGiorniEstesi(anno, mese)
  const firstMondayIdx = estesi.findIndex(g => new Date(g.data + 'T00:00:00').getDay() === 1)
  const start = firstMondayIdx === -1 ? 0 : firstMondayIdx
  const chunks: (typeof estesi)[] = []
  if (start > 0) chunks.push(estesi.slice(0, start))
  for (let i = start; i < estesi.length; i += 7) {
    const chunk = estesi.slice(i, i + 7)
    if (chunk.length > 0) chunks.push(chunk)
  }
  const nomeMese = MESI[mese - 1]
  return chunks
    .filter(chunk => chunk.some(g => g.mese === mese && g.anno === anno))
    .map(chunk => {
      const primo = chunk[0]
      const ultimo = chunk[chunk.length - 1]
      const labelMese = primo.mese !== ultimo.mese ? `${MESI[primo.mese - 1]} — ${MESI[ultimo.mese - 1]}` : nomeMese
      return {
        label: `${primo.giorno} ${primo.num} — ${ultimo.giorno} ${ultimo.num} ${labelMese}`,
        giorni: chunk,
      }
    })
}
