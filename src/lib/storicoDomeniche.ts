import { createClient } from '@supabase/supabase-js'

// FEATURE 2 (20 settembre 2026, richiesta Giacomo) — storico assegnazioni domenicali,
// minimo 2 mesi (default 60 giorni). Helper condiviso: usato sia dal pannello
// "📅 Storico Domeniche" (manager/page.tsx, via l'API route sotto) sia da Maia
// (maia-chat/route.ts, tool get_storico_domeniche) — STESSA fonte di verità, nessuna
// query duplicata.
//
// Client dedicato con `cache: 'no-store'` esplicito — stesso bug di caching Next.js/
// Supabase già documentato più volte in questo repo e in mangia-pwa2/CLAUDE.md, evitato
// qui a monte invece di scoprirlo dopo.
function noStoreClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  return createClient(url, key, {
    global: { fetch: (u: any, opts: any) => fetch(u, { ...opts, cache: 'no-store' }) },
  })
}

export interface StoricoDomenicaRow {
  employeeId: string
  nome: string
  domenicheLavorate: number
  ultimaDomenica: string | null // 'YYYY-MM-DD' o null se mai lavorata nella finestra
}

/** Conta le domeniche lavorate per ogni dipendente attivo dello store, negli ultimi
 * `giorni` (default 60 = 2 mesi). Include SEMPRE tutti i dipendenti attivi anche a 0
 * domeniche — è proprio chi ha 0 (o meno) a dover essere il più visibile per la
 * prossima assegnazione. Ordinato per conteggio crescente.
 *
 * 🐛 Fix (24 settembre 2026, segnalato da Giacomo — Yuri lavorato una domenica ma
 * assente dallo storico) — prima filtrava `tipo IN ('domenica_lungo','domenica_corto')`,
 * escludendo qualsiasi turno domenicale assegnato con un tipo diverso (es. "mattina" con
 * orario custom scelto manualmente dal menu a cascata — esattamente il caso reale di
 * Yuri, domenica 13/09/2026, tipo "mattina" 08:00-13:00). Ora conta come "domenica
 * lavorata" qualunque shift NON di riposo la cui `data` cade di domenica (calcolato dalla
 * data reale, non dal campo tipo) — copre sia le assegnazioni standard sia quelle
 * manuali con orari custom. Verificato che questo non fa comparire Gilda/Tony (esclusi
 * assoluti dalla domenica): ogni loro riga di domenica in produzione è `tipo: "riposo"`,
 * quindi restano correttamente a 0 anche col fix. */
export async function getStoricoDomeniche(storeId: string, giorni: number = 60): Promise<StoricoDomenicaRow[]> {
  const supabase = noStoreClient()
  const oggi = new Date()
  const cutoff = new Date(oggi)
  cutoff.setDate(cutoff.getDate() - giorni)
  const cutoffStr = cutoff.toISOString().split('T')[0]

  const { data: employees, error: empErr } = await supabase
    .from('employees').select('id, nome').eq('store_id', storeId).eq('attivo', true)
  if (empErr) throw new Error(`employees: ${empErr.message}`)

  // Schedule dello store nella finestra (una riga per mese) — le domeniche cadono sempre
  // dentro uno di questi, non serve iterare mese per mese sui giorni.
  const { data: schedules, error: schedErr } = await supabase
    .from('schedules').select('id').eq('store_id', storeId)
  if (schedErr) throw new Error(`schedules: ${schedErr.message}`)
  const scheduleIds = (schedules ?? []).map(s => s.id)
  if (scheduleIds.length === 0 || !employees || employees.length === 0) {
    return (employees ?? []).map(e => ({ employeeId: e.id, nome: e.nome, domenicheLavorate: 0, ultimaDomenica: null }))
  }

  // Nessun filtro sul campo `tipo` qui — Postgrest non può filtrare per giorno della
  // settimana di una colonna date, quindi si prende tutto il range e si filtra in JS
  // sotto (stesso principio già usato per il debug che ha trovato questo bug).
  const { data: shifts, error: shiftErr } = await supabase
    .from('shifts')
    .select('employee_id, data, tipo')
    .in('schedule_id', scheduleIds)
    .neq('tipo', 'riposo')
    .gte('data', cutoffStr)
  if (shiftErr) throw new Error(`shifts: ${shiftErr.message}`)

  const shiftsDomenica = (shifts ?? []).filter(s => new Date(s.data + 'T12:00:00').getDay() === 0)

  const conteggio = new Map<string, { count: number; ultima: string | null }>()
  for (const s of shiftsDomenica) {
    const cur = conteggio.get(s.employee_id) ?? { count: 0, ultima: null }
    cur.count += 1
    if (!cur.ultima || s.data > cur.ultima) cur.ultima = s.data
    conteggio.set(s.employee_id, cur)
  }

  const righe: StoricoDomenicaRow[] = employees.map(e => {
    const c = conteggio.get(e.id)
    return { employeeId: e.id, nome: e.nome, domenicheLavorate: c?.count ?? 0, ultimaDomenica: c?.ultima ?? null }
  })

  righe.sort((a, b) => a.domenicheLavorate - b.domenicheLavorate)
  return righe
}
