import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { generateShifts } from '@/lib/generator'

export async function POST(req: NextRequest) {
  const { schedule_id } = await req.json()
  if (!schedule_id) return NextResponse.json({ error: 'schedule_id required' }, { status: 400 })

  // Carica schedule
  const { data: schedule } = await supabaseAdmin
    .from('schedules').select('*').eq('id', schedule_id).single()
  if (!schedule) return NextResponse.json({ error: 'Schedule not found' }, { status: 404 })

  // Carica dipendenti
  const { data: employees } = await supabaseAdmin
    .from('employees').select('*').eq('store_id', schedule.store_id).eq('attivo', true)

  // Carica indisponibilità
  const { data: unavailabilities } = await supabaseAdmin
    .from('unavailabilities').select('*').eq('schedule_id', schedule_id)

  // Elimina turni esistenti
  await supabaseAdmin.from('shifts').delete().eq('schedule_id', schedule_id)

  // Genera
  const shifts = generateShifts({
    scheduleId: schedule_id,
    employees: employees || [],
    unavailabilities: unavailabilities || [],
    mese: schedule.mese,
    anno: schedule.anno
  })

  // Inserisce
  const { error } = await supabaseAdmin.from('shifts').insert(shifts)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, shifts_generated: shifts.length })
}
