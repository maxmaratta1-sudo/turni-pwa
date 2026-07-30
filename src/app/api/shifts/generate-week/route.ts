import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { generateShiftsMDWeek } from '@/lib/generator'

export async function POST(req: NextRequest) {
  try {
    const { schedule_id, week_start, week_end } = await req.json()

    if (!schedule_id || !week_start || !week_end) {
      return NextResponse.json({ error: 'schedule_id, week_start, week_end required' }, { status: 400 })
    }

    const { data: schedule, error: scheduleErr } = await supabaseAdmin
      .from('schedules').select('*').eq('id', schedule_id).single()
    if (scheduleErr) console.error('[shifts/generate-week] schedule fetch error:', JSON.stringify(scheduleErr, null, 2))
    if (!schedule) return NextResponse.json({ error: 'Schedule not found' }, { status: 404 })

    const { data: employees, error: employeesErr } = await supabaseAdmin
      .from('employees').select('*').eq('store_id', schedule.store_id).eq('attivo', true)
    if (employeesErr) console.error('[shifts/generate-week] employees fetch error:', JSON.stringify(employeesErr, null, 2))

    // Domenica già assegnata: è week_end + 1 giorno (week_end è il sabato di questa settimana).
    const sabato = new Date(week_end + 'T00:00:00')
    const domenica = new Date(sabato)
    domenica.setDate(domenica.getDate() + 1)
    const domenicaStr = domenica.toISOString().split('T')[0]

    const { data: domenicaShifts, error: domErr } = await supabaseAdmin
      .from('shifts')
      .select('employee_id, tipo')
      .eq('schedule_id', schedule_id)
      .eq('data', domenicaStr)
      .in('tipo', ['domenica_lungo', 'domenica_corto'])
    if (domErr) console.error('[shifts/generate-week] domenica fetch error:', JSON.stringify(domErr, null, 2))

    const { data: unavailabilities, error: unavailErr } = await supabaseAdmin
      .from('unavailabilities')
      .select('*')
      .eq('schedule_id', schedule_id)
      .gte('data', week_start)
      .lte('data', week_end)
    if (unavailErr) console.error('[shifts/generate-week] unavailabilities fetch error:', JSON.stringify(unavailErr, null, 2))

    // Elimina turni esistenti Lun-Sab di questa settimana (la domenica NON viene toccata).
    const { error: deleteErr } = await supabaseAdmin
      .from('shifts')
      .delete()
      .eq('schedule_id', schedule_id)
      .gte('data', week_start)
      .lte('data', week_end)
    if (deleteErr) console.error('[shifts/generate-week] delete error:', JSON.stringify(deleteErr, null, 2))

    const shifts = generateShiftsMDWeek({
      scheduleId: schedule_id,
      employees: employees || [],
      unavailabilities: unavailabilities || [],
      domenicaShifts: domenicaShifts || [],
      weekStart: week_start,
      weekEnd: week_end,
    })

    console.log('[shifts/generate-week] settimana:', week_start, '→', week_end, '| shifts da inserire:', shifts.length)

    const { error } = await supabaseAdmin.from('shifts').insert(shifts)
    if (error) {
      console.error('[shifts/generate-week] insert error:', JSON.stringify(error, null, 2))
      return NextResponse.json({ error: error.message, details: error.details, hint: error.hint, code: error.code }, { status: 500 })
    }

    return NextResponse.json({ ok: true, shifts_generated: shifts.length })
  } catch (error) {
    console.error('SHIFTS GENERATE-WEEK ERROR:', JSON.stringify(error, null, 2))
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
