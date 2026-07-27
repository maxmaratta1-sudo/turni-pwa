'use client'
import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { Employee, Schedule, Shift, TurnoTipo, MD_LANCIANO_STORE_NOME } from '@/types'
import MaiaChatBubble from '@/components/MaiaChatBubble'

const MESI = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno',
               'Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre']
const TURNO_CYCLE: Record<TurnoTipo, TurnoTipo> = {
  mattina: 'pomeriggio', pomeriggio: 'full', full: 'riposo', riposo: 'mattina',
  domenica_lungo: 'domenica_lungo', domenica_corto: 'domenica_corto',
}
const TURNO_LABEL: Record<string, string> = {
  mattina: 'M', pomeriggio: 'P', full: 'F', riposo: '—', domenica_lungo: 'DL', domenica_corto: 'DC'
}
const TURNO_COLOR: Record<string, string> = {
  mattina: 'bg-blue-100 text-blue-800',
  pomeriggio: 'bg-orange-100 text-orange-800',
  full: 'bg-green-100 text-green-800',
  riposo: 'bg-gray-100 text-gray-400',
  domenica_lungo: 'bg-purple-100 text-purple-800',
  domenica_corto: 'bg-purple-100 text-purple-800',
}

/** Prossimo turno nel ciclo di click — comportamento diverso per MD Lanciano (turni fissi, domenica attiva). */
function nextTurno(current: TurnoTipo, emp: Employee, isDomenica: boolean, isMD: boolean): TurnoTipo {
  if (!isMD) return TURNO_CYCLE[current] // Stroili — invariato

  if (isDomenica) {
    const cycle: Partial<Record<TurnoTipo, TurnoTipo>> = {
      riposo: 'domenica_lungo', domenica_lungo: 'domenica_corto', domenica_corto: 'riposo',
    }
    return cycle[current] ?? 'domenica_lungo'
  }

  // Gilda/Tony: turno fisso mattina, il click non li sposta mai in pomeriggio
  if (emp.turno_fisso === 'mattina') return 'mattina'

  const cycle: Partial<Record<TurnoTipo, TurnoTipo>> = {
    mattina: 'pomeriggio', pomeriggio: 'full', full: 'riposo', riposo: 'mattina',
    domenica_lungo: 'mattina', domenica_corto: 'mattina',
  }
  return cycle[current] ?? 'mattina'
}

interface Unavailability {
  id: string
  employee_id: string
  schedule_id: string
  data: string
  motivo: string | null
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

  const giorni = getDays(anno, mese)
  const isMD = storeNome === MD_LANCIANO_STORE_NOME

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

  // Seed del modal indisponibilità quando si apre per un dipendente
  useEffect(() => {
    if (!dettaglioEmp) return
    const dates = unavailabilities.filter(u => u.employee_id === dettaglioEmp.id).map(u => u.data)
    setModalSelected(new Set(dates))
    const firstMotivo = unavailabilities.find(u => u.employee_id === dettaglioEmp.id)?.motivo
    setModalMotivo(firstMotivo ?? '')
    setModalSaved(false)
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
      setEmployees(emps || [])

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

  async function pubblicaTurni() {
    if (!schedule) return
    await supabase.from('schedules').update({ stato: 'pubblicato' }).eq('id', schedule.id)
    setSchedule({ ...schedule, stato: 'pubblicato' })
  }

  async function addEmployee() {
    if (!newEmp.nome.trim()) return
    await fetch('/api/employees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...newEmp, store_id: storeId! })
    })
    setNewEmp({ nome: '', ore_settimanali: 20 })
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
    setEmployees(prev => [...prev, emp].sort((a, b) => a.nome.localeCompare(b.nome)))
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

  async function exportPDF() {
    const { jsPDF } = await import('jspdf')
    const { autoTable } = await import('jspdf-autotable')
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })

    const nomeMese = MESI[mese - 1]
    doc.setFontSize(14)
    doc.text(`Turni ${nomeMese} ${anno} — ${storeNome || 'Negozio'}`, 14, 14)

    const head = [['Dipendente', ...giorni.map(g => `${g.num}\n${g.giorno}`)]]
    const body = employees.map(emp => [
      emp.nome,
      ...giorni.map(g => {
        if (hasUnavailability(emp.id, g.data)) return 'P'
        const shift = getShift(emp.id, g.data)
        return TURNO_LABEL[shift?.tipo || 'riposo']
      })
    ])

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
          if (val === 'M') data.cell.styles.fillColor = [219, 234, 254]
          else if (val === 'P' && data.column.index > 0) data.cell.styles.fillColor = [254, 243, 199]
          else if (val === 'F') data.cell.styles.fillColor = [220, 252, 231]
          else if (val === '—') data.cell.styles.fillColor = [243, 244, 246]
        }
      }
    })

    doc.save(`turni-${nomeMese.toLowerCase()}-${anno}.pdf`)
  }

  function hasUnavailability(empId: string, data: string) {
    return unavailabilities.some(u => u.employee_id === empId && u.data === data)
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
    const res = await fetch('/api/unavailabilities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: dettaglioEmp.token,
        schedule_id: schedule.id,
        dates: Array.from(modalSelected),
        motivo: modalMotivo,
      }),
    })
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

    // Aggiornamento ottimistico
    if (existing) {
      setShifts(prev => prev.map(s =>
        s.employee_id === empId && s.data === data ? { ...s, tipo: nextTipo } : s
      ))
    } else {
      const optimistic: Shift = {
        id: `temp-${empId}-${data}`,
        schedule_id: schedule.id,
        employee_id: empId,
        data,
        tipo: nextTipo,
        ora_inizio: undefined,
        ora_fine: undefined
      }
      setShifts(prev => [...prev, optimistic])
    }

    // Persist su Supabase
    if (existing) {
      await supabase.from('shifts').update({ tipo: nextTipo }).eq('id', existing.id)
    } else {
      const { data: newShift } = await supabase.from('shifts')
        .insert({ schedule_id: schedule.id, employee_id: empId, data, tipo: nextTipo })
        .select().single()
      if (newShift) {
        setShifts(prev => prev.map(s =>
          s.id === `temp-${empId}-${data}` ? newShift : s
        ))
      }
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
          <h1 className="text-2xl font-bold text-gray-800">📅 Gestione Turni</h1>
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
              {schedule.stato === 'bozza' && shifts.length > 0 && (
                <button onClick={pubblicaTurni} className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700">
                  ✅ Pubblica
                </button>
              )}
              {shifts.length > 0 && (
                <button onClick={exportPDF} className="bg-gray-600 text-white px-4 py-2 rounded hover:bg-gray-700">
                  📄 Crea PDF
                </button>
              )}
              <span className={`px-3 py-1 rounded-full text-sm font-medium ${
                schedule.stato === 'pubblicato' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'
              }`}>
                {schedule.stato === 'pubblicato' ? '✅ Pubblicato' : '📝 Bozza'}
              </span>
            </>
          )}
        </div>

        {/* Aggiungi dipendente */}
        <div className="bg-white rounded-xl shadow-sm p-4 mb-6">
          <h2 className="font-semibold text-gray-700 mb-3">👤 Dipendenti</h2>
          <div className="flex gap-3 mb-4 flex-wrap">
            <input type="text" placeholder="Nome dipendente"
              className="border rounded px-3 py-2 flex-1 min-w-48"
              value={newEmp.nome} onChange={e => setNewEmp({...newEmp, nome: e.target.value})} />
            <select className="border rounded px-3 py-2"
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
            <button onClick={addEmployee} className="bg-gray-800 text-white px-4 py-2 rounded hover:bg-gray-700">
              + Aggiungi
            </button>
          </div>
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

        {/* Tabella turni */}
        {shifts.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm overflow-x-auto mb-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left p-3 font-semibold text-gray-700 sticky left-0 bg-white min-w-32">Dipendente</th>
                  {giorni.map(g => (
                    <th key={g.data} className={`p-2 text-center font-medium min-w-10 ${g.domenica ? 'bg-red-50 text-red-400' : 'text-gray-600'}`}>
                      <div className="text-xs">{g.giorno}</div>
                      <div className="text-xs text-gray-400">{g.num}</div>
                    </th>
                  ))}
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
                    {giorni.map(g => {
                      const shift = getShift(emp.id, g.data)
                      const tipo = shift?.tipo || 'riposo'
                      const isPermesso = hasUnavailability(emp.id, g.data)
                      const domenicaBloccata = g.domenica && !isMD
                      const cellBg = g.domenica ? (isMD ? 'bg-purple-50' : 'bg-red-50') : ''

                      if (isPermesso && tipo === 'riposo') {
                        return (
                          <td key={g.data} className={`p-1 text-center ${cellBg}`}>
                            <button
                              onClick={() => !domenicaBloccata && cycleShift(emp.id, g.data)}
                              disabled={domenicaBloccata}
                              title="Permesso"
                              className="inline-block px-1 py-0.5 rounded text-xs font-bold bg-yellow-100 text-yellow-800 hover:opacity-80 disabled:cursor-not-allowed">
                              P
                            </button>
                          </td>
                        )
                      }

                      return (
                        <td key={g.data} className={`p-1 text-center ${cellBg}`}>
                          <button
                            onClick={() => !domenicaBloccata && cycleShift(emp.id, g.data)}
                            disabled={domenicaBloccata}
                            title={`Click per cambiare (attuale: ${tipo})`}
                            className={`inline-block px-1 py-0.5 rounded text-xs font-bold hover:opacity-80 disabled:cursor-not-allowed ${TURNO_COLOR[tipo]}`}>
                            {TURNO_LABEL[tipo]}
                          </button>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="p-3 text-xs text-gray-400 flex gap-4 flex-wrap">
              <span><strong>M</strong> = Mattina {isMD ? '8-14' : '9-14'}</span>
              <span><strong>P</strong> = Pomeriggio 14-20</span>
              <span><strong>F</strong> = Full {isMD ? '8-20' : '9-20'}</span>
              <span><strong>—</strong> = Riposo</span>
              <span><strong className="text-yellow-700">P</strong><span className="text-yellow-700"> = Permesso</span></span>
              {isMD && <span><strong className="text-purple-700">DL</strong><span className="text-purple-700"> = Domenica lungo 8-13</span></span>}
              {isMD && <span><strong className="text-purple-700">DC</strong><span className="text-purple-700"> = Domenica corto 10-13</span></span>}
            </div>
          </div>
        )}

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
                  <label className="block text-sm font-medium text-gray-700 mb-1">Motivo (opzionale)</label>
                  <input type="text" placeholder="es. visita medica, impegno familiare..."
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                    value={modalMotivo} onChange={e => { setModalMotivo(e.target.value); setModalSaved(false) }} />
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
        employees={employees}
        shifts={shifts}
        giorni={giorni}
        mese={mese}
        anno={anno}
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
