'use client'
import { useState, useEffect } from 'react'
import { Employee, Shift } from '@/types'

interface Msg { role: 'user' | 'assistant'; content: string }

interface Props {
  isMD: boolean
  storeNome: string
  storeId: string | null
  scheduleId: string | null
  employees: Employee[]
  shifts: Shift[]
  giorni: { data: string }[]
  mese: number
  anno: number
  settimanaInizio?: string | null
  settimanaFine?: string | null
}

const TIPO_LETTER: Record<string, string> = {
  mattina: 'M', pomeriggio: 'P', full: 'F', riposo: '—', domenica_lungo: 'DL', domenica_corto: 'DC',
  yuri_full: 'YF', yuri_pomeriggio: 'Y', mattina_corta: 'M5', pomeriggio_corto: 'P5',
}

function buildContext(employees: Employee[], shifts: Shift[], giorni: { data: string }[]): string {
  const empList = employees.map(e =>
    `- ${e.nome}: ${e.ore_settimanali}h, ruolo: ${e.ruolo ?? 'cassiere'}` +
    `${e.turno_fisso ? `, turno fisso: ${e.turno_fisso}` : ''}` +
    `${e.alternanza_gruppo ? `, gruppo alternanza: ${e.alternanza_gruppo}` : ''}`
  ).join('\n')

  const turniRiepilogo = employees.map(e => {
    const rowLetters = giorni.map(g => {
      const s = shifts.find(sh => sh.employee_id === e.id && sh.data === g.data)
      return TIPO_LETTER[s?.tipo ?? 'riposo'] ?? '—'
    }).join(' ')
    return `${e.nome}: ${rowLetters}`
  }).join('\n')

  return `DIPENDENTI ATTUALI:\n${empList || 'Nessun dipendente.'}\n\nTURNI DEL MESE CORRENTE:\n${turniRiepilogo || 'Nessun turno generato ancora.'}`
}

/**
 * Chat bubble "Maia — Turni Manager". Visibile SOLO per MD Lanciano — il system
 * prompt è specifico per quel negozio, non ha senso mostrarla ad altri store (Stroili).
 * La chiamata ad Anthropic passa sempre da /api/maia-chat: la chiave resta server-side.
 */
export default function MaiaChatBubble({ isMD, storeNome, storeId, scheduleId, employees, shifts, giorni, mese, anno, settimanaInizio, settimanaFine }: Props) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)

  async function sendText(text: string) {
    if (!text || loading) return
    const nextMessages: Msg[] = [...messages, { role: 'user', content: text }]
    setMessages(nextMessages)
    setInput('')
    setLoading(true)

    try {
      const res = await fetch('/api/maia-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: nextMessages,
          context: buildContext(employees, shifts, giorni),
          mese, anno, storeId, scheduleId,
          settimana_inizio: settimanaInizio ?? undefined,
          settimana_fine: settimanaFine ?? undefined,
        }),
      })
      const data = await res.json()
      setMessages(prev => [...prev, { role: 'assistant', content: data.reply || `⚠️ ${data.error ?? 'Errore'}` }])
      if (data.shiftsUpdated) {
        window.dispatchEvent(new CustomEvent('maiaShiftUpdated'))
      }
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: '⚠️ Errore di connessione.' }])
    }
    setLoading(false)
  }

  async function send() {
    await sendText(input.trim())
  }

  function aggiornaContesto() {
    // Ricarica shifts/unavailabilities dal DB (già gestito da manager/page.tsx sull'evento
    // esistente) — la prossima domanda a Maia userà automaticamente i dati freschi, dato
    // che buildContext legge sempre lo stato `shifts` corrente al momento dell'invio.
    window.dispatchEvent(new CustomEvent('maiaShiftUpdated'))
    setMessages(prev => [...prev, { role: 'assistant', content: '🔄 Contesto aggiornato — ho i turni più recenti della settimana.' }])
  }

  // Messaggi automatici inviati dall'esterno (es. bottone "Controlla turni" nel manager)
  useEffect(() => {
    if (!isMD) return
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ message: string }>).detail
      if (!detail?.message) return
      setOpen(true)
      sendText(detail.message)
    }
    window.addEventListener('maiaAutoMessage', handler as EventListener)
    return () => window.removeEventListener('maiaAutoMessage', handler as EventListener)
  }, [isMD, messages, loading, employees, shifts, giorni, mese, anno, storeId, scheduleId, settimanaInizio, settimanaFine])

  if (!isMD) return null

  return (
    <>
      <button
        onClick={() => setOpen(v => !v)}
        className="fixed bottom-5 right-5 z-50 w-14 h-14 rounded-full bg-purple-600 hover:bg-purple-700 text-white text-2xl shadow-lg flex items-center justify-center transition"
        title="Maia — Turni Manager">
        {open ? '✕' : '✨'}
      </button>

      {open && (
        <div className="fixed bottom-24 right-5 z-50 bg-white rounded-2xl shadow-2xl border border-gray-200 flex flex-col"
          style={{ width: 380, height: 500, maxWidth: 'calc(100vw - 2.5rem)', maxHeight: 'calc(100vh - 7rem)' }}>
          <div className="flex items-center justify-between px-4 py-3 border-b bg-purple-600 rounded-t-2xl">
            <h3 className="text-white font-semibold text-sm">✨ Maia — Turni Manager</h3>
            <div className="flex items-center gap-1">
              <button onClick={aggiornaContesto} className="text-white/70 hover:text-white text-sm px-2" title="Aggiorna turni">
                🔄
              </button>
              <button onClick={() => setOpen(false)} className="text-white/80 hover:text-white text-lg">✕</button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-2 text-sm">
            {messages.length === 0 && (
              <p className="text-gray-400 text-xs text-center mt-4">
                Chiedimi qualsiasi cosa sui turni di {storeNome} — copertura, dipendenti, suggerimenti.
              </p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] rounded-xl px-3 py-2 whitespace-pre-wrap ${
                  m.role === 'user' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-800'
                }`}>
                  {m.content}
                </div>
              </div>
            ))}
            {loading && <div className="text-gray-400 text-xs">Maia sta scrivendo...</div>}
          </div>

          <div className="p-3 border-t flex gap-2">
            <input
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') send() }}
              placeholder="Scrivi a Maia..."
              className="flex-1 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-400"
            />
            <button onClick={send} disabled={loading}
              className="bg-purple-600 text-white px-3 py-2 rounded-lg text-sm font-medium hover:bg-purple-700 disabled:opacity-50">
              Invia
            </button>
          </div>
        </div>
      )}
    </>
  )
}
