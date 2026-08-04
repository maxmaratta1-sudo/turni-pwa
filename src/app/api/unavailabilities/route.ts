import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { calcolaTurnoRidotto } from '@/lib/generator'

// POST: dipendente/manager salva le indisponibilità
export async function POST(req: NextRequest) {
  const { token, schedule_id, dates, motivo, tipo_assenza, inserito_da, ore_parziali } = await req.json()

  // Verifica token
  const { data: employee } = await supabaseAdmin
    .from('employees').select('*').eq('token', token).single()
  if (!employee) return NextResponse.json({ error: 'Token non valido' }, { status: 401 })

  // Giorni che avevano un permesso a ore PRIMA di questo salvataggio — servono per
  // ripristinare l'orario originale del turno se il permesso viene rimosso/sostituito.
  const { data: vecchiParziali } = await supabaseAdmin
    .from('unavailabilities')
    .select('data, ore_parziali')
    .eq('employee_id', employee.id)
    .eq('schedule_id', schedule_id)
    .not('ore_parziali', 'is', null)

  // Elimina vecchie indisponibilità per questo schedule
  await supabaseAdmin
    .from('unavailabilities')
    .delete()
    .eq('employee_id', employee.id)
    .eq('schedule_id', schedule_id)

  const oreParzialiNum = tipo_assenza === 'P' && typeof ore_parziali === 'number' && ore_parziali > 0 ? ore_parziali : null

  // Inserisce nuove
  if (dates && dates.length > 0) {
    const rows = dates.map((data: string) => ({
      employee_id: employee.id,
      schedule_id,
      data,
      motivo: motivo || null,
      tipo_assenza: tipo_assenza || 'P',
      inserito_da: inserito_da || 'dipendente',
      ore_parziali: oreParzialiNum,
    }))
    const { error } = await supabaseAdmin.from('unavailabilities').insert(rows)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Permesso a ore: accorcia il turno esistente (entra più tardi) invece di lasciarlo
    // intatto — l'assenza intera resta invariata (gestita solo lato unavailabilities/cella).
    if (oreParzialiNum) {
      for (const data of dates) {
        const { data: shift } = await supabaseAdmin
          .from('shifts')
          .select('ora_inizio, ora_fine')
          .eq('schedule_id', schedule_id)
          .eq('employee_id', employee.id)
          .eq('data', data)
          .maybeSingle()

        const nuovoOrario = calcolaTurnoRidotto(shift?.ora_inizio, shift?.ora_fine, oreParzialiNum)
        if (nuovoOrario) {
          await supabaseAdmin.from('shifts')
            .update({ ora_inizio: nuovoOrario.ora_inizio, ora_fine: nuovoOrario.ora_fine })
            .eq('schedule_id', schedule_id).eq('employee_id', employee.id).eq('data', data)
        }
      }
    }
  }

  // Ripristina l'orario originale dei giorni che avevano permesso a ore e NON fanno più
  // parte del nuovo set (permesso rimosso, cambiato tipo, o tornato a giornata intera).
  const nuoveDateConParziali = new Set(oreParzialiNum ? (dates || []) : [])
  for (const vecchio of vecchiParziali || []) {
    if (nuoveDateConParziali.has(vecchio.data) || !vecchio.ore_parziali) continue
    const { data: shift } = await supabaseAdmin
      .from('shifts')
      .select('ora_inizio')
      .eq('schedule_id', schedule_id)
      .eq('employee_id', employee.id)
      .eq('data', vecchio.data)
      .maybeSingle()
    if (shift?.ora_inizio) {
      const [h, m] = shift.ora_inizio.split(':').map(Number)
      const oraOriginale = `${String(h - vecchio.ore_parziali).padStart(2, '0')}:${String(m).padStart(2, '0')}`
      await supabaseAdmin.from('shifts')
        .update({ ora_inizio: oraOriginale })
        .eq('schedule_id', schedule_id).eq('employee_id', employee.id).eq('data', vecchio.data)
    }
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
