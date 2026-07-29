import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { oreFromOrario } from '@/lib/generator'

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== 'Bearer debug-md-2026-temp') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { data: stores } = await supabaseAdmin.from('stores').select('id, nome')
  const md = stores?.find(s => s.nome === 'MD Lanciano')
  if (!md) return NextResponse.json({ error: 'not found' })

  const { data: emp } = await supabaseAdmin.from('employees').select('*').eq('store_id', md.id).ilike('nome', 'Angelica').maybeSingle()
  if (!emp) return NextResponse.json({ error: 'Angelica not found' })

  const { data: schedules } = await supabaseAdmin.from('schedules').select('*').eq('store_id', md.id).order('anno', { ascending: false }).order('mese', { ascending: false })
  const sched = schedules?.[0]

  const { data: shifts } = await supabaseAdmin.from('shifts').select('*').eq('schedule_id', sched.id).eq('employee_id', emp.id).order('data')

  return NextResponse.json({
    employee: emp,
    shifts: shifts?.map(s => ({ data: s.data, tipo: s.tipo, inizio: s.ora_inizio, fine: s.ora_fine, ore: oreFromOrario(s.ora_inizio, s.ora_fine) })),
  })
}
