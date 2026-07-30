import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== 'Bearer debug-md-2026-temp') return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: stef } = await supabaseAdmin.from('employees').select('id').ilike('nome', 'Stefania').single()
  const scheduleId = '5c4daad2-427b-4f26-8847-dcc3a3bc3896'
  const { data: unav } = await supabaseAdmin.from('unavailabilities').select('*').eq('employee_id', stef?.id ?? '').eq('data', '2026-08-03')
  const { data: shift } = await supabaseAdmin.from('shifts').select('*').eq('employee_id', stef?.id ?? '').eq('schedule_id', scheduleId).eq('data', '2026-08-03')
  const { data: shiftDom } = await supabaseAdmin.from('shifts').select('*').eq('employee_id', stef?.id ?? '').eq('schedule_id', scheduleId).eq('data', '2026-08-09')

  return NextResponse.json({ unavailability: unav, shift3agosto: shift, shift9agosto: shiftDom })
}
