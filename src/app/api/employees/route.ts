import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  const store_id = req.nextUrl.searchParams.get('store_id')
  const { data } = await supabaseAdmin
    .from('employees').select('*').eq('store_id', store_id).eq('attivo', true).order('nome')
  return NextResponse.json(data || [])
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { data, error } = await supabaseAdmin
    .from('employees').insert(body).select().single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id')
  await supabaseAdmin.from('employees').update({ attivo: false }).eq('id', id)
  return NextResponse.json({ ok: true })
}
