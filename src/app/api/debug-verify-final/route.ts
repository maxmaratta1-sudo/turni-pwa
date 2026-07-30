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

  const perEmpWeek: Record<string, Record<number, number>> = {}
  for (const s of shifts || []) {
    if (s.tipo === 'riposo') continue
    const emp = employees?.find(e => e.id === s.employee_id)
    const nome = emp?.nome ?? s.employee_id
    if (nome !== 'Cristina' && nome !== 'Stefania') continue
    const week = getIsoWeek(new Date(s.data + 'T00:00:00'))
    perEmpWeek[nome] = perEmpWeek[nome] || {}
    perEmpWeek[nome][week] = (perEmpWeek[nome][week] || 0) + oreFromOrario(s.ora_inizio, s.ora_fine)
  }

  const perGiorno: Record<string, number> = {}
  for (const s of shifts || []) {
    if (s.ora_fine?.startsWith('20:00')) perGiorno[s.data] = (perGiorno[s.data] || 0) + 1
  }
  const giorniProblematici = Object.entries(perGiorno).filter(([data, count]) => {
    const isSabato = new Date(data + 'T00:00:00').getDay() === 6
    return count < (isSabato ? 4 : 3)
  })

  return NextResponse.json({ cristinaStefaniaWeekly: perEmpWeek, giorniProblematiciChiusura: giorniProblematici })
}
