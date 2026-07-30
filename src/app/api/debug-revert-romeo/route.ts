import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function DELETE(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== 'Bearer debug-md-2026-temp') return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: romeo } = await supabaseAdmin.from('employees').select('id').ilike('nome', 'Romeo').single()
  const scheduleId = '5c4daad2-427b-4f26-8847-dcc3a3bc3896'
  if (!romeo) return NextResponse.json({ error: 'not found' })

  await supabaseAdmin.from('shifts').delete().eq('schedule_id', scheduleId).eq('employee_id', romeo.id).eq('data', '2026-08-09')

  return NextResponse.json({ ok: true })
}
