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

const CASSIERE = ['Angelica', 'Damiana', 'Elisa', 'Marilena']

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== 'Bearer debug-md-2026-temp') return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const scheduleId = '5c4daad2-427b-4f26-8847-dcc3a3bc3896'
  const { data: employees } = await supabaseAdmin.from('employees').select('*')
  const { data: shifts } = await supabaseAdmin.from('shifts').select('*').eq('schedule_id', scheduleId)

  const perGiornoConteggio: Record<string, { mattina: string[]; pomeriggio: string[] }> = {}
  const perEmpWeek: Record<string, Record<number, number>> = {}

  for (const s of shifts || []) {
    const emp = employees?.find(e => e.id === s.employee_id)
    const nome = emp?.nome ?? s.employee_id
    if (!CASSIERE.includes(nome)) continue

    if (s.tipo !== 'riposo') {
      const week = getIsoWeek(new Date(s.data + 'T00:00:00'))
      perEmpWeek[nome] = perEmpWeek[nome] || {}
      perEmpWeek[nome][week] = (perEmpWeek[nome][week] || 0) + oreFromOrario(s.ora_inizio, s.ora_fine)
    }

    if (!perGiornoConteggio[s.data]) perGiornoConteggio[s.data] = { mattina: [], pomeriggio: [] }
    if (s.tipo === 'mattina') perGiornoConteggio[s.data].mattina.push(nome)
    if (s.tipo === 'pomeriggio') perGiornoConteggio[s.data].pomeriggio.push(nome)
  }

  const giorniSbagliati = Object.entries(perGiornoConteggio).filter(([data, c]) => {
    const isDom = new Date(data + 'T00:00:00').getDay() === 0
    if (isDom) return false
    return c.mattina.length !== 2 || c.pomeriggio.length !== 2
  })

  return NextResponse.json({ perEmpWeek, giorniSbagliati, sampleGiorni: Object.entries(perGiornoConteggio).slice(0, 6) })
}
