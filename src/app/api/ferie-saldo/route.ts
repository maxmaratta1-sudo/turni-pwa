import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET: recupera saldo dipendente (?employee_id=&anno=)
export async function GET(req: NextRequest) {
  const employeeId = req.nextUrl.searchParams.get('employee_id')
  const anno = req.nextUrl.searchParams.get('anno')
  if (!employeeId) return NextResponse.json({ error: 'employee_id richiesto' }, { status: 400 })

  const { data, error } = await supabaseAdmin
    .from('ferie_saldo')
    .select('*')
    .eq('employee_id', employeeId)
    .eq('anno', anno ? parseInt(anno, 10) : new Date().getFullYear())
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ saldo: data })
}

// PATCH: aggiorna saldo con un delta (somma, non sostituisce)
// body: { employee_id, anno, delta_ferie_giorni?, delta_permessi_ore? }
export async function PATCH(req: NextRequest) {
  const { employee_id, anno, delta_ferie_giorni, delta_permessi_ore } = await req.json()
  if (!employee_id) return NextResponse.json({ error: 'employee_id richiesto' }, { status: 400 })

  const annoFinal = anno ?? new Date().getFullYear()

  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from('ferie_saldo')
    .select('*')
    .eq('employee_id', employee_id)
    .eq('anno', annoFinal)
    .maybeSingle()
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 })
  if (!existing) return NextResponse.json({ error: 'Saldo non trovato per questo dipendente/anno' }, { status: 404 })

  const nuoviGiorniUsati = existing.ferie_giorni_usati + (delta_ferie_giorni ?? 0)
  const nuoveOreUsate = existing.permessi_ore_usate + (delta_permessi_ore ?? 0)

  const { data, error } = await supabaseAdmin
    .from('ferie_saldo')
    .update({
      ferie_giorni_usati: Math.max(0, nuoviGiorniUsati),
      permessi_ore_usate: Math.max(0, nuoveOreUsate),
    })
    .eq('id', existing.id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ saldo: data })
}
