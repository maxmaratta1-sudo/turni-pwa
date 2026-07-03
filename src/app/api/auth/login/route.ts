import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { supabaseAdmin } from '@/lib/supabase'

export async function POST(req: NextRequest) {
  const { email, password } = await req.json()

  if (!email || !password) {
    return NextResponse.json({ error: 'Email e password richiesti' }, { status: 400 })
  }

  const { data: manager, error } = await supabaseAdmin
    .from('managers')
    .select('*, stores(id, nome)')
    .eq('email', email.toLowerCase().trim())
    .single()

  if (error || !manager) {
    return NextResponse.json({ error: 'Credenziali non valide' }, { status: 401 })
  }

  const valid = await bcrypt.compare(password, manager.password_hash)
  if (!valid) {
    return NextResponse.json({ error: 'Credenziali non valide' }, { status: 401 })
  }

  return NextResponse.json({
    store_id: manager.store_id,
    store_nome: manager.stores?.nome ?? '',
    email: manager.email,
  })
}
