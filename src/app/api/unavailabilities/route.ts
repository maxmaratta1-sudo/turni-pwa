import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// POST: dipendente salva le sue indisponibilità
export async function POST(req: NextRequest) {
  const { token, schedule_id, dates, motivo } = await req.json()

  // Verifica token
  const { data: employee } = await supabaseAdmin
    .from('employees').select('*').eq('token', token).single()
  if (!employee) return NextResponse.json({ error: 'Token non valido' }, { status: 401 })

  // Elimina vecchie indisponibilità per questo schedule
  await supabaseAdmin
    .from('unavailabilities')
    .delete()
    .eq('employee_id', employee.id)
    .eq('schedule_id', schedule_id)

  // Inserisce nuove
  if (dates && dates.length > 0) {
    const rows = dates.map((data: string) => ({
      employee_id: employee.id,
      schedule_id,
      data,
      motivo: motivo || null
    }))
    const { error } = await supabaseAdmin.from('unavailabilities').insert(rows)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}

// GET: recupera indisponibilità di un dipendente
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token')
  const schedule_id = req.nextUrl.searchParams.get('schedule_id')

  const { data: employee } = await supabaseAdmin
    .from('employees').select('*').eq('token', token).single()
  if (!employee) return NextResponse.json({ error: 'Token non valido' }, { status: 401 })

  const { data } = await supabaseAdmin
    .from('unavailabilities')
    .select('*')
    .eq('employee_id', employee.id)
    .eq('schedule_id', schedule_id)

  return NextResponse.json({ employee, unavailabilities: data || [] })
}
