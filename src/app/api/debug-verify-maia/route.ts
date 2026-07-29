import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== 'Bearer debug-md-2026-temp') return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const empId = '63b23b49-270b-4afc-8a15-68df9e388616' // Angelica
  const scheduleId = '5c4daad2-427b-4f26-8847-dcc3a3bc3896'

  const { data: unav } = await supabaseAdmin.from('unavailabilities').select('*').eq('employee_id', empId).eq('schedule_id', scheduleId).eq('data', '2026-08-03')
  const { data: shift } = await supabaseAdmin.from('shifts').select('*').eq('employee_id', empId).eq('schedule_id', scheduleId).eq('data', '2026-08-03')
  const { data: saldo } = await supabaseAdmin.from('ferie_saldo').select('*').eq('employee_id', empId).eq('anno', 2026).maybeSingle()

  return NextResponse.json({ unavailability: unav, shift, saldo })
}
