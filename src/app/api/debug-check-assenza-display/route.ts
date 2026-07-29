import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== 'Bearer debug-md-2026-temp') return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const scheduleId = '5c4daad2-427b-4f26-8847-dcc3a3bc3896' // Agosto 2026 MD Lanciano
  const { data: unav } = await supabaseAdmin.from('unavailabilities').select('*').eq('schedule_id', scheduleId)
  if (!unav || unav.length === 0) return NextResponse.json({ ok: true, message: 'nessuna assenza registrata per questo schedule', mismatches: [] })

  const mismatches: any[] = []
  for (const u of unav) {
    const { data: shift } = await supabaseAdmin.from('shifts').select('*').eq('schedule_id', scheduleId).eq('employee_id', u.employee_id).eq('data', u.data).maybeSingle()
    if (shift && shift.tipo !== 'riposo') {
      mismatches.push({ employee_id: u.employee_id, data: u.data, tipo_assenza: u.tipo_assenza, shiftTipo: shift.tipo })
    }
  }

  return NextResponse.json({ ok: true, unavailabilitiesCount: unav.length, mismatches })
}
