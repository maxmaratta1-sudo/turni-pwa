import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== 'Bearer debug-md-2026-temp') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const scheduleId = '5c4daad2-427b-4f26-8847-dcc3a3bc3896'
  const empId = '62ce98f6-111b-428e-8e02-fb2374c0485b'
  const { data: shifts } = await supabaseAdmin.from('shifts').select('*').eq('schedule_id', scheduleId).eq('employee_id', empId).order('data')
  return NextResponse.json({ shifts })
}
