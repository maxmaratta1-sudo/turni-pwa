import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { oreFromOrario } from '@/lib/generator'

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== 'Bearer debug-md-2026-temp') return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: romeo } = await supabaseAdmin.from('employees').select('*').ilike('nome', 'Romeo').single()
  const scheduleId = '5c4daad2-427b-4f26-8847-dcc3a3bc3896'
  const { data: shifts } = await supabaseAdmin.from('shifts').select('*').eq('schedule_id', scheduleId).eq('employee_id', romeo?.id ?? '').order('data')

  const conOre = (shifts || []).map(s => ({ data: s.data, tipo: s.tipo, ora_inizio: s.ora_inizio, ora_fine: s.ora_fine, ore: oreFromOrario(s.ora_inizio, s.ora_fine) }))
  const maxOre = Math.max(...conOre.map(s => s.ore))

  return NextResponse.json({ romeo, maxOreGiorno: maxOre, shifts: conOre })
}
