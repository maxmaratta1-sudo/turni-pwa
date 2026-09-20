import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

const TOKEN = 'volt-store-id-20092026'

export async function GET(req: NextRequest) {
  if (new URL(req.url).searchParams.get('token') !== TOKEN) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const { data } = await supabaseAdmin.from('employees').select('store_id, nome').limit(1)
  return NextResponse.json({ data })
}
