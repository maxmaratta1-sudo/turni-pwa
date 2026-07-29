import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== 'Bearer debug-md-2026-temp') return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: stores } = await supabaseAdmin.from('stores').select('id, nome')
  const md = stores?.find(s => s.nome === 'MD Lanciano')
  if (!md) return NextResponse.json({ error: 'MD Lanciano non trovato' })

  const { data: employees } = await supabaseAdmin.from('employees').select('id, nome').eq('store_id', md.id).eq('attivo', true)
  const { data: saldi, error } = await supabaseAdmin.from('ferie_saldo').select('*').eq('anno', 2026)

  return NextResponse.json({
    error: error?.message ?? null,
    employeesCount: employees?.length,
    saldiCount: saldi?.length,
    saldi: saldi?.map(s => ({ nome: employees?.find(e => e.id === s.employee_id)?.nome, ...s })),
  })
}
