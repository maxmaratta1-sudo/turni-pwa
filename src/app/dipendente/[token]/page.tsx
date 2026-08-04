'use client'
import { useState, useEffect } from 'react'
import { useParams, useSearchParams } from 'next/navigation'

interface Employee {
  id: string
  store_id: string
  nome: string
  ore_settimanali: number
}

const MESI = ['','Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno',
               'Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre']

export default function DipendenteePage() {
  const { token } = useParams<{ token: string }>()
  const searchParams = useSearchParams()
  const scheduleIdParam = searchParams.get('schedule_id')

  const [employee, setEmployee] = useState<Employee | null>(null)
  const [schedule, setSchedule] = useState<any>(null)
  const [resolvedScheduleId, setResolvedScheduleId] = useState<string | null>(null)
  const [selectedDates, setSelectedDates] = useState<Set<string>>(new Set())
  const [motivo, setMotivo] = useState('')
  const [tipoAssenza, setTipoAssenza] = useState('P')
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)
  const [conflitti, setConflitti] = useState<Record<string, string[]>>({})
  const [ultimoGiornoToccato, setUltimoGiornoToccato] = useState<string | null>(null)
  const [festiviMap, setFestiviMap] = useState<Record<string, string>>({})

  useEffect(() => {
    if (token) loadData()
  }, [token])

  useEffect(() => {
    if (!employee || !resolvedScheduleId) return
    fetch(`/api/unavailabilities/conflitti?schedule_id=${resolvedScheduleId}&ore_settimanali=${employee.ore_settimanali}&employee_id=${employee.id}`)
      .then(r => r.json())
      .then(data => setConflitti(data.conflitti || {}))
      .catch(() => {})
  }, [employee, resolvedScheduleId])

  async function loadData() {
    const res = await fetch(`/api/unavailabilities?token=${token}&schedule_id=${scheduleIdParam ?? ''}`)
    const data = await res.json()
    if (!data.employee) { setLoading(false); return }
    setEmployee(data.employee)

    const { createClient } = await import('@supabase/supabase-js')
    const sb = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    )

    // Risolvi lo schedule: prima prova URL param, poi fallback mese corrente
    let sched = null
    const paramOk = scheduleIdParam && scheduleIdParam !== 'undefined' && scheduleIdParam !== 'null' && scheduleIdParam !== ''
    if (paramOk) {
      const { data: s } = await sb.from('schedules').select('*').eq('id', scheduleIdParam).single()
      sched = s
    }
    if (!sched && data.employee?.store_id) {
      const now = new Date()
      const { data: s } = await sb.from('schedules').select('*')
        .eq('store_id', data.employee.store_id)
        .eq('mese', now.getMonth() + 1)
        .eq('anno', now.getFullYear())
        .maybeSingle()
      sched = s
    }

    setSchedule(sched)
    setResolvedScheduleId(sched?.id ?? null)

    // Festivi (negozio chiuso, non selezionabili) — stesso trattamento della domenica.
    let festivi: Record<string, string> = {}
    if (data.employee?.store_id) {
      const { data: festiviData } = await sb.from('turni_festivi')
        .select('data, nome').eq('store_id', data.employee.store_id)
      festivi = Object.fromEntries((festiviData || []).map((f: any) => [f.data, f.nome]))
      setFestiviMap(festivi)
    }

    // Carica unavailabilities con lo schedule risolto
    if (sched?.id) {
      const { data: unavRes } = await sb.from('unavailabilities')
        .select('*')
        .eq('employee_id', data.employee.id)
        .eq('schedule_id', sched.id)
      // Esclude domenica/festivi dal conteggio: sono giorni non selezionabili (negozio
      // chiuso), un record residuo per una di queste date (es. inserito prima che il
      // giorno diventasse festivo, o da un flusso che non rispetta l'esclusione) non deve
      // gonfiare il numero mostrato nel bottone senza comparire evidenziato in rosso.
      const dateValide = (unavRes || [])
        .map((u: any) => u.data)
        .filter((d: string) => {
          const dow = new Date(d + 'T00:00:00').getDay()
          return dow !== 0 && !festivi[d]
        })
      setSelectedDates(new Set(dateValide))
      // Carica motivo se c'è un solo motivo comune (prendi il primo)
      const firstMotivo = unavRes?.[0]?.motivo
      if (firstMotivo) setMotivo(firstMotivo)
      const firstTipo = unavRes?.[0]?.tipo_assenza
      if (firstTipo) setTipoAssenza(firstTipo)
    }

    setLoading(false)
  }

  function toggleDate(data: string) {
    const next = new Set(selectedDates)
    if (next.has(data)) next.delete(data)
    else next.add(data)
    setSelectedDates(next)
    setSaved(false)
    setUltimoGiornoToccato(data)
  }

  const giornoConConflitto = ultimoGiornoToccato && selectedDates.has(ultimoGiornoToccato) && conflitti[ultimoGiornoToccato]?.length
    ? ultimoGiornoToccato
    : null

  async function salva() {
    if (!resolvedScheduleId) return
    const res = await fetch('/api/unavailabilities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        schedule_id: resolvedScheduleId,
        dates: Array.from(selectedDates),
        motivo,
        tipo_assenza: tipoAssenza,
      })
    })
    if (res.ok) setSaved(true)
  }

  if (loading) return <div className="min-h-screen flex items-center justify-center text-gray-500">Caricamento...</div>
  if (!employee) return <div className="min-h-screen flex items-center justify-center text-red-500">Link non valido</div>
  if (!schedule) return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm p-6 text-center max-w-sm">
        <p className="text-gray-500">Nessun piano turni attivo per questo mese.<br/>Contatta il tuo responsabile.</p>
      </div>
    </div>
  )

  const giorni = getDays(schedule.anno, schedule.mese)

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-lg mx-auto">
        <div className="bg-white rounded-2xl shadow-sm p-6 mb-4">
          <h1 className="text-xl font-bold text-gray-800">Ciao {employee.nome}! 👋</h1>
          <p className="text-gray-500 mt-1">
            Turni di {MESI[schedule.mese]} {schedule.anno}
          </p>
          <p className="text-sm text-gray-600 mt-3">
            Seleziona i giorni in cui <strong>non sei disponibile</strong>.<br/>
            Se non hai problemi, lascia tutto vuoto e salva.
          </p>
        </div>

        {/* Calendario */}
        <div className="bg-white rounded-2xl shadow-sm p-4 mb-4">
          <div className="grid grid-cols-7 gap-1 text-center text-xs text-gray-400 mb-2">
            {['L','M','M','G','V','S','D'].map((d,i) => <div key={i}>{d}</div>)}
          </div>
          <CalGrid giorni={giorni} selected={selectedDates} onToggle={toggleDate} conflitti={conflitti} festivi={festiviMap} />
        </div>

        {giornoConConflitto && (
          <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 mb-4">
            <p className="text-orange-800 font-semibold text-sm">
              ⚠️ Attenzione — {conflitti[giornoConConflitto]?.join(', ')} {conflitti[giornoConConflitto]?.length === 1 ? 'ha' : 'hanno'} già richiesto questo giorno.
            </p>
            <p className="text-orange-600 text-xs mt-1">
              Puoi comunque inviare la tua richiesta. Sarà Giacomo a decidere come organizzare i turni.
            </p>
          </div>
        )}

        {selectedDates.size > 0 && (
          <div className="bg-white rounded-2xl shadow-sm p-4 mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Tipo assenza
            </label>
            <select value={tipoAssenza} onChange={e => setTipoAssenza(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm mb-3">
              <option value="P">P — Permesso</option>
              <option value="F">F — Ferie</option>
              <option value="R">R — Recupero</option>
              <option value="M">M — Malattia</option>
              <option value="MT">MT — Maternità</option>
            </select>

            <label className="block text-sm font-medium text-gray-700 mb-2">
              Motivo (opzionale)
            </label>
            <input type="text" placeholder="es. visita medica, impegno familiare..."
              className="w-full border rounded-lg px-3 py-2 text-sm"
              value={motivo} onChange={e => setMotivo(e.target.value)} />
          </div>
        )}

        <button onClick={salva}
          className={`w-full py-3 rounded-xl font-semibold text-white transition ${
            saved ? 'bg-green-500' : 'bg-blue-600 hover:bg-blue-700'
          }`}>
          {saved ? '✅ Salvato!' : selectedDates.size > 0
            ? `Invia ${selectedDates.size} giorni di indisponibilità`
            : 'Nessun problema — Salva disponibilità'}
        </button>
      </div>
    </div>
  )
}

function CalGrid({ giorni, selected, onToggle, conflitti, festivi }: {
  giorni: ReturnType<typeof getDays>,
  selected: Set<string>,
  onToggle: (d: string) => void,
  conflitti?: Record<string, string[]>,
  festivi?: Record<string, string>
}) {
  if (!giorni.length) return null
  // Fix timezone: parse come data locale aggiungendo T00:00:00
  const firstDay = new Date(giorni[0].data + 'T00:00:00').getDay()
  const offset = firstDay === 0 ? 6 : firstDay - 1

  return (
    <div className="grid grid-cols-7 gap-1">
      {Array(offset).fill(null).map((_, i) => <div key={`e${i}`} />)}
      {giorni.map(g => {
        const haConflitto = !!conflitti?.[g.data]?.length
        const isSelected = selected.has(g.data)
        const nomeFestivo = festivi?.[g.data]
        const nonSelezionabile = g.domenica || !!nomeFestivo
        return (
          <button key={g.data} onClick={() => !nonSelezionabile && onToggle(g.data)}
            disabled={nonSelezionabile}
            title={nomeFestivo ? nomeFestivo : haConflitto ? `${conflitti![g.data].join(', ')} ${conflitti![g.data].length === 1 ? 'ha' : 'hanno'} già richiesto questo giorno` : undefined}
            className={`relative aspect-square rounded-lg text-sm font-medium transition flex items-center justify-center
              ${nonSelezionabile ? 'text-gray-300 cursor-not-allowed' :
                isSelected && haConflitto ? 'bg-orange-500 text-white' :
                isSelected ? 'bg-red-500 text-white' :
                'hover:bg-gray-100 text-gray-700'}`}>
            {g.num}
            {!isSelected && haConflitto && !nonSelezionabile && (
              <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-orange-500" />
            )}
          </button>
        )
      })}
    </div>
  )
}

// Fix timezone: usa formato YYYY-MM-DD locale senza toISOString (che converte in UTC)
function getDays(anno: number, mese: number) {
  const days = []
  const d = new Date(anno, mese - 1, 1)
  while (d.getMonth() === mese - 1) {
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    days.push({
      data: `${yyyy}-${mm}-${dd}`,
      num: d.getDate(),
      domenica: d.getDay() === 0
    })
    d.setDate(d.getDate() + 1)
  }
  return days
}
