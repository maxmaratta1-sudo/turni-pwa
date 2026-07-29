import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== 'Bearer debug-md-2026-temp') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const results: Record<string, any> = {}

  for (const table of ['unavailabilities', 'turni_unavailabilities', 'stores', 'turni_stores', 'regole', 'turni_regole']) {
    const { error, data } = await supabaseAdmin.from(table).select('*').limit(1)
    results[table] = error ? { exists: false, error: error.message } : { exists: true, sample: data }
  }

  return NextResponse.json(results)
}
