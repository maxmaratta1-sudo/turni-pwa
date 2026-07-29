import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== 'Bearer debug-md-2026-temp') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { data: stores } = await supabaseAdmin.from('stores').select('id, nome')
  const md = stores?.find(s => s.nome === 'MD Lanciano')
  if (!md) return NextResponse.json({ error: 'not found' })

  const { data: emp } = await supabaseAdmin.from('employees').select('*').eq('store_id', md.id).ilike('nome', 'Damiana').maybeSingle()

  const { data: realU } = await supabaseAdmin.from('unavailabilities').select('*').eq('employee_id', emp?.id ?? '')
  const { data: phantomU } = await supabaseAdmin.from('turni_unavailabilities').select('*')

  const { data: schedules } = await supabaseAdmin.from('schedules').select('*').eq('store_id', md.id).order('anno', { ascending: false }).order('mese', { ascending: false })

  return NextResponse.json({ employee: emp, realUnavailabilities: realU, phantomTableAll: phantomU, schedules })
}
