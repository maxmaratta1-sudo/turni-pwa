import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { generateShifts, oreFromOrario } from '@/lib/generator'

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== 'Bearer debug-md-2026-temp') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { data: stores } = await supabaseAdmin.from('stores').select('id, nome')
  const md = stores?.find(s => s.nome === 'MD Lanciano')
  if (!md) return NextResponse.json({ error: 'MD Lanciano store non trovato', stores })

  const { data: employees } = await supabaseAdmin.from('employees').select('*').eq('store_id', md.id).eq('attivo', true)

  const { data: schedule, error: schedErr } = await supabaseAdmin
    .from('schedules').insert({ store_id: md.id, mese: 8, anno: 2099, stato: 'bozza' }).select().single()
  if (schedErr || !schedule) return NextResponse.json({ error: schedErr?.message })

  const shifts = generateShifts({
    scheduleId: schedule.id,
    employees: employees || [],
    unavailabilities: [],
    mese: 8,
    anno: 2099,
    storeNome: md.nome,
  })

  const { error: insErr } = await supabaseAdmin.from('shifts').insert(shifts)

  const perEmp: Record<string, number> = {}
  for (const s of shifts) {
    const emp = employees?.find(e => e.id === s.employee_id)
    const nome = emp?.nome ?? s.employee_id
    const ore = s.tipo !== 'riposo' ? oreFromOrario(s.ora_inizio, s.ora_fine) : 0
    perEmp[nome] = (perEmp[nome] || 0) + ore
  }

  // cleanup
  await supabaseAdmin.from('shifts').delete().eq('schedule_id', schedule.id)
  await supabaseAdmin.from('schedules').delete().eq('id', schedule.id)

  return NextResponse.json({
    insertError: insErr?.message ?? null,
    shiftsCount: shifts.length,
    totalHoursByEmployee: perEmp,
    employeeContracts: employees?.map(e => ({ nome: e.nome, ore_settimanali: e.ore_settimanali })),
  })
}
