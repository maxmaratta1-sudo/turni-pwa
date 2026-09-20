import { NextRequest, NextResponse } from 'next/server'
import { getStoricoDomeniche } from '@/lib/storicoDomeniche'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const storeId = searchParams.get('store_id')
  const giorni = searchParams.get('giorni')
  if (!storeId) return NextResponse.json({ error: 'store_id required' }, { status: 400 })
  try {
    const righe = await getStoricoDomeniche(storeId, giorni ? Number(giorni) : undefined)
    return NextResponse.json({ righe })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
