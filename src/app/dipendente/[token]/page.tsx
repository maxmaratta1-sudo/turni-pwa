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
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (token) loadData()
  }, [token])

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

    // Carica unavailabilities con lo schedule risolto
    if (sched?.id) {
      const { data: unavRes } = await sb.from('unavailabilities')
        .select('*')
        .eq('employee_id', data.employee.id)
        .eq('schedule_id', sched.id)
      setSelectedDates(new Set((unavRes || []).map((u: any) => u.data)))
      // Carica motivo se c'è un solo motivo comune (prendi il primo)
      const firstMotivo = unavRes?.[0]?.motivo
      if (firstMotivo) setMotivo(firstMotivo)
    }

    setLoading(false)
  }

  function toggleDate(data: string) {
    const next = new Set(selectedDates)
    if (next.has(data)) next.delete(data)
    else next.add(data)
    setSelectedDates(next)
    setSaved(false)
  }

  async function salva() {
    if (!resolvedScheduleId) return
    const res = await fetch('/api/unavailabilities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        schedule_id: resolvedScheduleId,
        dates: Array.from(selectedDates),
        motivo
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
          <CalGrid giorni={giorni} selected={selectedDates} onToggle={toggleDate} />
        </div>

        {selectedDates.size > 0 && (
          <div className="bg-white rounded-2xl shadow-sm p-4 mb-4">
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

function CalGrid({ giorni, selected, onToggle }: {
  giorni: ReturnType<typeof getDays>,
  selected: Set<string>,
  onToggle: (d: string) => void
}) {
  if (!giorni.length) return null
  // Fix timezone: parse come data locale aggiungendo T00:00:00
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
