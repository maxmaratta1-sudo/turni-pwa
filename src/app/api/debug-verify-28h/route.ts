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
  if (auth !== 'Bearer debug-md-2026-temp') return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const scheduleId = '5c4daad2-427b-4f26-8847-dcc3a3bc3896'
  const { data: employees } = await supabaseAdmin.from('employees').select('*')
  const { data: shifts } = await supabaseAdmin.from('shifts').select('*').eq('schedule_id', scheduleId)

  const nomi28h = ['Romeo', 'Cristina', 'Stefania']
  const perEmpWeek: Record<string, Record<number, number>> = {}
  const romeoShiftsSample: any[] = []

  for (const s of shifts || []) {
    if (s.tipo === 'riposo') continue
    const emp = employees?.find(e => e.id === s.employee_id)
    const nome = emp?.nome ?? s.employee_id
    if (!nomi28h.includes(nome)) continue
    const week = getIsoWeek(new Date(s.data + 'T00:00:00'))
    perEmpWeek[nome] = perEmpWeek[nome] || {}
    perEmpWeek[nome][week] = (perEmpWeek[nome][week] || 0) + oreFromOrario(s.ora_inizio, s.ora_fine)

    if (nome === 'Romeo' && s.data >= '2026-08-03' && s.data <= '2026-08-08') {
      romeoShiftsSample.push({ data: s.data, tipo: s.tipo, ora_inizio: s.ora_inizio, ora_fine: s.ora_fine })
    }
  }

  return NextResponse.json({ perEmpWeek, romeoShiftsSample })
}
