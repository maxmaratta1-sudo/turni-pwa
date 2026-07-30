import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET: restituisce i giorni già richiesti da colleghi con lo stesso contratto
// (stesso store, stesso ore_settimanali), escludendo il dipendente corrente.
export async function GET(req: NextRequest) {
  const schedule_id = req.nextUrl.searchParams.get('schedule_id')
  const ore_settimanali = req.nextUrl.searchParams.get('ore_settimanali')
  const employee_id = req.nextUrl.searchParams.get('employee_id')

  if (!schedule_id || !ore_settimanali || !employee_id) {
    return NextResponse.json({ error: 'Parametri mancanti' }, { status: 400 })
  }

  const { data: currentEmp } = await supabaseAdmin
    .from('employees').select('store_id').eq('id', employee_id).maybeSingle()
  if (!currentEmp) return NextResponse.json({ conflitti: {} })

  const { data: colleghi } = await supabaseAdmin
    .from('employees')
    .select('id, nome')
    .eq('store_id', currentEmp.store_id)
    .eq('ore_settimanali', parseInt(ore_settimanali, 10))
    .neq('id', employee_id)

  if (!colleghi || colleghi.length === 0) return NextResponse.json({ conflitti: {} })

  const { data: unavails } = await supabaseAdmin
    .from('unavailabilities')
    .select('data, employee_id')
    .eq('schedule_id', schedule_id)
    .in('employee_id', colleghi.map(c => c.id))

  const conflitti: Record<string, string[]> = {}
  for (const u of unavails || []) {
    const collega = colleghi.find(c => c.id === u.employee_id)
    if (!collega) continue
    if (!conflitti[u.data]) conflitti[u.data] = []
    conflitti[u.data].push(collega.nome)
  }

  return NextResponse.json({ conflitti })
}
