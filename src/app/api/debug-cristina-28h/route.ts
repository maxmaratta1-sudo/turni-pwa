import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== 'Bearer debug-md-2026-temp') return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: stores } = await supabaseAdmin.from('stores').select('id, nome')
  const md = stores?.find(s => s.nome === 'MD Lanciano')
  if (!md) return NextResponse.json({ error: 'store not found' })

  const { data, error } = await supabaseAdmin
    .from('employees')
    .update({ ore_settimanali: 28 })
    .eq('nome', 'Cristina')
    .eq('store_id', md.id)
    .select()

  return NextResponse.json({ error: error?.message ?? null, updated: data })
}
