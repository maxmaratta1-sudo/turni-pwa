import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { generateShifts } from '@/lib/generator'

export async function POST(req: NextRequest) {
  try {
    const { schedule_id } = await req.json()
    if (!schedule_id) return NextResponse.json({ error: 'schedule_id required' }, { status: 400 })

    // Carica schedule
    const { data: schedule, error: scheduleErr } = await supabaseAdmin
      .from('schedules').select('*').eq('id', schedule_id).single()
    if (scheduleErr) console.error('[shifts/generate] schedule fetch error:', JSON.stringify(scheduleErr, null, 2))
    if (!schedule) return NextResponse.json({ error: 'Schedule not found' }, { status: 404 })

    // Carica store (per selezionare l'algoritmo giusto — MD Lanciano vs default)
    const { data: store, error: storeErr } = await supabaseAdmin
      .from('stores').select('nome').eq('id', schedule.store_id).single()
    if (storeErr) console.error('[shifts/generate] store fetch error:', JSON.stringify(storeErr, null, 2))

    // Carica dipendenti
    const { data: employees, error: employeesErr } = await supabaseAdmin
      .from('employees').select('*').eq('store_id', schedule.store_id).eq('attivo', true)
    if (employeesErr) console.error('[shifts/generate] employees fetch error:', JSON.stringify(employeesErr, null, 2))

    // Carica indisponibilità
    const { data: unavailabilities, error: unavailErr } = await supabaseAdmin
      .from('unavailabilities').select('*').eq('schedule_id', schedule_id)
    if (unavailErr) console.error('[shifts/generate] unavailabilities fetch error:', JSON.stringify(unavailErr, null, 2))

    // Elimina turni esistenti
    const { error: deleteErr } = await supabaseAdmin.from('shifts').delete().eq('schedule_id', schedule_id)
    if (deleteErr) console.error('[shifts/generate] delete error:', JSON.stringify(deleteErr, null, 2))

    // Genera
    const shifts = await generateShifts({
      scheduleId: schedule_id,
      employees: employees || [],
      unavailabilities: unavailabilities || [],
      mese: schedule.mese,
      anno: schedule.anno,
      storeNome: store?.nome,
    })

    console.log('[shifts/generate] store:', store?.nome, '| employees:', employees?.length, '| shifts da inserire:', shifts.length)

    // Inserisce
    const { error } = await supabaseAdmin.from('shifts').insert(shifts)
    if (error) {
      console.error('[shifts/generate] insert error:', JSON.stringify(error, null, 2))
      return NextResponse.json({ error: error.message, details: error.details, hint: error.hint, code: error.code }, { status: 500 })
    }

    return NextResponse.json({ ok: true, shifts_generated: shifts.length })
  } catch (error) {
    console.error('SHIFTS GENERATE ERROR:', JSON.stringify(error, null, 2))
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
