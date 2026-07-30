import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== 'Bearer debug-md-2026-temp') return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const scheduleId = '5c4daad2-427b-4f26-8847-dcc3a3bc3896'
  const { data: shifts } = await supabaseAdmin.from('shifts').select('data, ora_fine').eq('schedule_id', scheduleId)

  const perGiorno: Record<string, number> = {}
  for (const s of shifts || []) {
    if (s.ora_fine?.startsWith('20:00')) perGiorno[s.data] = (perGiorno[s.data] || 0) + 1
  }
  const giorniProblematici = Object.entries(perGiorno).filter(([data, count]) => {
    const isSabato = new Date(data + 'T00:00:00').getDay() === 6
    return count < (isSabato ? 4 : 3)
  })

  return NextResponse.json({ giorniProblematici })
}
