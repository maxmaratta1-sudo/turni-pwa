import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== 'Bearer debug-md-2026-temp') return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: stores } = await supabaseAdmin.from('stores').select('id, nome')
  const md = stores?.find(s => s.nome === 'MD Lanciano')
  if (!md) return NextResponse.json({ error: 'not found' })

  const { data: schedules } = await supabaseAdmin.from('schedules').select('*').eq('store_id', md.id).order('anno').order('mese')

  const out: any[] = []
  for (const s of schedules || []) {
    const { count } = await supabaseAdmin.from('shifts').select('*', { count: 'exact', head: true }).eq('schedule_id', s.id)
    const { data: sample } = await supabaseAdmin.from('shifts').select('created_at').eq('schedule_id', s.id).limit(1)
    out.push({ mese: s.mese, anno: s.anno, schedule_id: s.id, shiftsCount: count, lastGeneratedAt: sample?.[0]?.created_at ?? null })
  }

  return NextResponse.json({ schedules: out })
}
