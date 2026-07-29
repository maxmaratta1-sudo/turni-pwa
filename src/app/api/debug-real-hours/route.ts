import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { oreFromOrario } from '@/lib/generator'

function getIsoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== 'Bearer debug-md-2026-temp') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { data: stores } = await supabaseAdmin.from('stores').select('id, nome')
  const md = stores?.find(s => s.nome === 'MD Lanciano')
  if (!md) return NextResponse.json({ error: 'MD Lanciano non trovato', stores })

  const { data: schedules } = await supabaseAdmin.from('schedules').select('*').eq('store_id', md.id).order('anno', { ascending: false }).order('mese', { ascending: false })
  const sched = schedules?.[0]
  if (!sched) return NextResponse.json({ error: 'nessuno schedule trovato' })

  const { data: employees } = await supabaseAdmin.from('employees').select('*').eq('store_id', md.id)
  const { data: shifts } = await supabaseAdmin.from('shifts').select('*').eq('schedule_id', sched.id)
  const { data: unavail } = await supabaseAdmin.from('unavailabilities').select('*').eq('schedule_id', sched.id)

  const perEmpWeek: Record<string, Record<number, number>> = {}
  for (const s of shifts || []) {
    const emp = employees?.find(e => e.id === s.employee_id)
    const nome = emp?.nome ?? s.employee_id
    if (s.tipo === 'riposo') continue
    const week = getIsoWeek(new Date(s.data + 'T00:00:00'))
    const ore = oreFromOrario(s.ora_inizio, s.ora_fine)
    perEmpWeek[nome] = perEmpWeek[nome] || {}
    perEmpWeek[nome][week] = (perEmpWeek[nome][week] || 0) + ore
  }

  return NextResponse.json({
    schedule: { id: sched.id, mese: sched.mese, anno: sched.anno },
    shiftsCount: shifts?.length,
    unavailCount: unavail?.length,
    perEmployeeWeeklyHours: perEmpWeek,
    contracts: employees?.map(e => ({ nome: e.nome, ore_settimanali: e.ore_settimanali })),
  })
}
