import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { generateShiftsMD } from '@/lib/generator'

export async function POST(req: NextRequest) {
  try {
    const { schedule_id } = await req.json()
    if (!schedule_id) return NextResponse.json({ error: 'schedule_id required' }, { status: 400 })

    // Carica schedule
    const { data: schedule, error: scheduleErr } = await supabaseAdmin
      .from('schedules').select('*').eq('id', schedule_id).single()
    if (scheduleErr) console.error('[shifts/generate] schedule fetch error:', JSON.stringify(scheduleErr, null, 2))
    if (!schedule) return NextResponse.json({ error: 'Schedule not found' }, { status: 404 })

    // Carica dipendenti
    const { data: employees, error: employeesErr } = await supabaseAdmin
      .from('employees').select('*').eq('store_id', schedule.store_id).eq('attivo', true)
    if (employeesErr) console.error('[shifts/generate] employees fetch error:', JSON.stringify(employeesErr, null, 2))

    // Carica indisponibilità
    const { data: unavailabilities, error: unavailErr } = await supabaseAdmin
      .from('unavailabilities').select('*').eq('schedule_id', schedule_id)
    if (unavailErr) console.error('[shifts/generate] unavailabilities fetch error:', JSON.stringify(unavailErr, null, 2))

    // FIX 1 (20 settembre 2026, richiesta Giacomo — Opzione 2): "Genera turni" (mese
    // intero) prima cancellava e rigenerava TUTTI i turni del mese incondizionatamente,
    // asimmetrico rispetto a "Genera settimana" (che già salta i giorni con turno
    // esistente — vedi shifts/generate-week/route.ts, `turniManuale`). Chi rigenerava il
    // mese dopo aver modificato manualmente una cella (click diretto o via Maia) si
    // ritrovava la modifica cancellata senza nessun avviso. Ora stesso comportamento:
    // i turni esistenti (già assegnati, manuali o generati) vengono preservati, si genera
    // solo per gli slot dipendente/giorno ancora vuoti. "🗑️ Reset mese" resta l'unico
    // modo esplicito per ripartire davvero da zero.
    const { data: esistenti, error: esistentiErr } = await supabaseAdmin
      .from('shifts').select('employee_id, data').eq('schedule_id', schedule_id)
    if (esistentiErr) console.error('[shifts/generate] turni esistenti fetch error:', JSON.stringify(esistentiErr, null, 2))
    const turniEsistenti = new Set((esistenti ?? []).map(t => `${t.employee_id}_${t.data}`))

    // Genera (la funzione produce comunque un turno per OGNI dipendente/giorno, come
    // sempre — il filtro sotto è quello che preserva gli esistenti)
    const shiftsGenerati = await generateShiftsMD({
      scheduleId: schedule_id,
      employees: employees || [],
      unavailabilities: unavailabilities || [],
      mese: schedule.mese,
      anno: schedule.anno,
    })

    const shifts = shiftsGenerati.filter(s => !turniEsistenti.has(`${s.employee_id}_${s.data}`))
    const saltatiPerEsistenti = shiftsGenerati.length - shifts.length

    console.log('[shifts/generate] employees:', employees?.length, '| shifts da inserire:', shifts.length, '| preservati (già esistenti):', saltatiPerEsistenti)

    // Inserisce SOLO i nuovi (mai un delete)
    const { error } = await supabaseAdmin.from('shifts').insert(shifts)
    if (error) {
      console.error('[shifts/generate] insert error:', JSON.stringify(error, null, 2))
      return NextResponse.json({ error: error.message, details: error.details, hint: error.hint, code: error.code }, { status: 500 })
    }

    return NextResponse.json({ ok: true, shifts_generated: shifts.length, shifts_preservati: saltatiPerEsistenti })
  } catch (error) {
    console.error('SHIFTS GENERATE ERROR:', JSON.stringify(error, null, 2))
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
