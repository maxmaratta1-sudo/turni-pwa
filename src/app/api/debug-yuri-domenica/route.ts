import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// Route di debug TEMPORANEA — verifica sola lettura del record reale di
// Yuri per capire perché "Storico Domeniche" non lo mostra (segnalato da
// Giacomo). Rimuovere subito dopo l'uso.
const TOKEN = 'volt-yuri-domenica-24092026'

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get('token') !== TOKEN) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { global: { fetch: (u: any, opts: any) => fetch(u, { ...opts, cache: 'no-store' }) } }
  )

  const { data: yuri, error: yuriErr } = await supabase
    .from('employees')
    .select('id, nome, store_id, attivo')
    .ilike('nome', '%yuri%')

  if (yuriErr || !yuri || yuri.length === 0) {
    return NextResponse.json({ step: 'employees', error: yuriErr?.message ?? 'Yuri non trovato' }, { status: 500 })
  }

  const ids = yuri.map((y) => y.id)
  const { data: shifts, error: shiftErr } = await supabase
    .from('shifts')
    .select('id, employee_id, data, tipo, ora_inizio, ora_fine, schedule_id')
    .in('employee_id', ids)
    .order('data', { ascending: true })

  // Verifica anche Gilda/Tony (esclusi assoluti dalla domenica)
  const { data: gildaTony } = await supabase
    .from('employees')
    .select('id, nome')
    .or('nome.ilike.%gilda%,nome.ilike.%tony%')

  let shiftsGildaTony: any[] = []
  if (gildaTony && gildaTony.length > 0) {
    const idsGT = gildaTony.map((g) => g.id)
    const { data } = await supabase
      .from('shifts')
      .select('employee_id, data, tipo')
      .in('employee_id', idsGT)
    shiftsGildaTony = data ?? []
  }

  // Filtra shifts di Yuri che cadono di domenica (JS getDay()===0), a
  // prescindere dal campo tipo
  const shiftsDomenica = (shifts ?? []).filter((s) => new Date(s.data + 'T12:00:00').getDay() === 0)

  return NextResponse.json({
    yuri,
    tutti_gli_shift_yuri: shifts ?? [],
    shift_yuri_che_cadono_di_domenica: shiftsDomenica,
    gilda_tony_trovati: gildaTony ?? [],
    shifts_gilda_tony: shiftsGildaTony,
  })
}
