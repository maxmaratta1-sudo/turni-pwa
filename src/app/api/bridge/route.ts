import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

const MD_STORE_NOME = 'MD Lanciano'

function authCheck(req: NextRequest): boolean {
  const key = req.headers.get('x-api-key')
  return !!key && key === process.env.TURNI_API_KEY
}

function getMonday(d: Date): Date {
  const date = new Date(d)
  const day = date.getDay()
  const diff = date.getDate() - day + (day === 0 ? -6 : 1)
  date.setDate(diff)
  return date
}

function formatDateIt(d: Date): string {
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' })
}

function toDateStr(d: Date): string {
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

async function getStoreId(): Promise<string | null> {
  const { data } = await supabaseAdmin.from('stores').select('id').eq('nome', MD_STORE_NOME).maybeSingle()
  return data?.id ?? null
}

async function getScheduleId(storeId: string, date: Date): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('schedules')
    .select('id')
    .eq('store_id', storeId)
    .eq('mese', date.getMonth() + 1)
    .eq('anno', date.getFullYear())
    .maybeSingle()
  return data?.id ?? null
}

async function findEmployee(nome: string, storeId: string) {
  const { data } = await supabaseAdmin
    .from('employees')
    .select('id, nome, ore_settimanali')
    .eq('store_id', storeId)
    .ilike('nome', nome)
    .maybeSingle()
  return data
}

// GET — legge dati turni
export async function GET(req: NextRequest) {
  if (!authCheck(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = req.nextUrl
  const action = searchParams.get('action')

  const store_id = await getStoreId()
  if (!store_id) return NextResponse.json({ error: 'Store MD Lanciano non trovato' }, { status: 404 })

  if (action === 'turni_settimana') {
    const oggi = new Date()
    const lun = getMonday(oggi)
    const dom = new Date(lun)
    dom.setDate(dom.getDate() + 6)

    const schedule_id = await getScheduleId(store_id, oggi)
    if (!schedule_id) return NextResponse.json({ error: 'Nessun piano turni per il mese corrente' }, { status: 404 })

    const { data: shifts, error } = await supabaseAdmin
      .from('shifts')
      .select('data, tipo, ora_inizio, ora_fine, employees(nome, ore_settimanali)')
      .eq('schedule_id', schedule_id)
      .gte('data', toDateStr(lun))
      .lte('data', toDateStr(dom))
      .neq('tipo', 'riposo')
      .order('data')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ shifts, settimana: `${formatDateIt(lun)} - ${formatDateIt(dom)}` })
  }

  if (action === 'turni_dipendente') {
    const nome = searchParams.get('nome')
    if (!nome) return NextResponse.json({ error: 'Parametro nome richiesto' }, { status: 400 })
    const mese = parseInt(searchParams.get('mese') || String(new Date().getMonth() + 1), 10)
    const anno = parseInt(searchParams.get('anno') || String(new Date().getFullYear()), 10)

    const emp = await findEmployee(nome, store_id)
    if (!emp) return NextResponse.json({ error: `Dipendente "${nome}" non trovato` }, { status: 404 })

    const schedule_id = await getScheduleId(store_id, new Date(anno, mese - 1, 1))
    if (!schedule_id) return NextResponse.json({ error: `Nessun piano turni per ${mese}/${anno}` }, { status: 404 })

    const { data: shifts, error } = await supabaseAdmin
      .from('shifts')
      .select('data, tipo, ora_inizio, ora_fine')
      .eq('employee_id', emp.id)
      .eq('schedule_id', schedule_id)
      .neq('tipo', 'riposo')
      .order('data')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ nome: emp.nome, mese, anno, turni: shifts })
  }

  if (action === 'chi_lavora') {
    const data = searchParams.get('data') || toDateStr(new Date())
    const d = new Date(data + 'T00:00:00')

    const schedule_id = await getScheduleId(store_id, d)
    if (!schedule_id) return NextResponse.json({ error: 'Nessun piano turni per questa data' }, { status: 404 })

    const { data: shifts, error } = await supabaseAdmin
      .from('shifts')
      .select('data, tipo, ora_inizio, ora_fine, employees(nome)')
      .eq('schedule_id', schedule_id)
      .eq('data', data)
      .neq('tipo', 'riposo')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ data, dipendenti: shifts })
  }

  if (action === 'saldo_ferie') {
    const nome = searchParams.get('nome')
    if (!nome) return NextResponse.json({ error: 'Parametro nome richiesto' }, { status: 400 })

    const emp = await findEmployee(nome, store_id)
    if (!emp) return NextResponse.json({ error: `Dipendente "${nome}" non trovato` }, { status: 404 })

    const { data: saldo } = await supabaseAdmin
      .from('ferie_saldo')
      .select('*')
      .eq('employee_id', emp.id)
      .eq('anno', new Date().getFullYear())
      .maybeSingle()

    return NextResponse.json({
      nome: emp.nome,
      ferie_rimanenti: ((saldo?.ferie_giorni_totali || 0) - (saldo?.ferie_giorni_usati || 0)).toFixed(2),
      permessi_rimanenti: ((saldo?.permessi_ore_totali || 0) - (saldo?.permessi_ore_usate || 0)).toFixed(2),
    })
  }

  return NextResponse.json({ error: 'Action non valida' }, { status: 400 })
}

// POST — modifica turni (solo Giacomo)
export async function POST(req: NextRequest) {
  if (!authCheck(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { action, richiedente } = body

  // REGOLA INDISCUTIBILE: solo Giacomo può modificare
  if (richiedente !== 'giacomo') {
    return NextResponse.json({
      error: 'Non autorizzato',
      messaggio: 'Solo Giacomo può modificare i turni. Contatta Giacomo o chiedi a Maia di avvisarlo.',
    }, { status: 403 })
  }

  const store_id = await getStoreId()
  if (!store_id) return NextResponse.json({ error: 'Store MD Lanciano non trovato' }, { status: 404 })

  if (action === 'update_shift') {
    const { nome, data, tipo, ora_inizio, ora_fine } = body
    const emp = await findEmployee(nome, store_id)
    if (!emp) return NextResponse.json({ error: `Dipendente "${nome}" non trovato` }, { status: 404 })

    const schedule_id = await getScheduleId(store_id, new Date(data + 'T00:00:00'))
    if (!schedule_id) return NextResponse.json({ error: 'Nessun piano turni per questa data' }, { status: 404 })

    const { error } = await supabaseAdmin.from('shifts').upsert(
      { schedule_id, employee_id: emp.id, data, tipo, ora_inizio: ora_inizio ?? null, ora_fine: ora_fine ?? null },
      { onConflict: 'schedule_id,employee_id,data' }
    )
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ ok: true, messaggio: `Turno di ${emp.nome} aggiornato per ${data}` })
  }

  if (action === 'set_assenza') {
    const { nome, dates, tipo_assenza, motivo } = body
    if (!Array.isArray(dates) || dates.length === 0) {
      return NextResponse.json({ error: 'Parametro dates richiesto (array di date YYYY-MM-DD)' }, { status: 400 })
    }
    const emp = await findEmployee(nome, store_id)
    if (!emp) return NextResponse.json({ error: `Dipendente "${nome}" non trovato` }, { status: 404 })

    const schedule_id = await getScheduleId(store_id, new Date(dates[0] + 'T00:00:00'))
    if (!schedule_id) return NextResponse.json({ error: 'Nessun piano turni per questa data' }, { status: 404 })

    for (const d of dates) {
      await supabaseAdmin.from('unavailabilities').delete()
        .eq('employee_id', emp.id).eq('schedule_id', schedule_id).eq('data', d)
      await supabaseAdmin.from('unavailabilities').insert({
        employee_id: emp.id, schedule_id, data: d,
        tipo_assenza, motivo: motivo || null, inserito_da: 'maia_whatsapp',
      })

      await supabaseAdmin.from('shifts').upsert(
        { schedule_id, employee_id: emp.id, data: d, tipo: 'riposo', ora_inizio: null, ora_fine: null },
        { onConflict: 'schedule_id,employee_id,data' }
      )
    }

    // FIX 2 (7 agosto 2026): tipo_assenza resta "R" nel DB, ma il messaggio verso chi ha
    // chiamato il bridge (es. maia-turni.ts in mangia-pwa2) deve dire "REC" per il
    // Recupero — stessa disambiguazione di manager/page.tsx e maia-chat/route.ts.
    const tipoAssenzaDisplay = tipo_assenza === 'R' ? 'REC' : tipo_assenza
    return NextResponse.json({ ok: true, messaggio: `${tipoAssenzaDisplay} registrata per ${emp.nome}` })
  }

  return NextResponse.json({ error: 'Action non valida' }, { status: 400 })
}
