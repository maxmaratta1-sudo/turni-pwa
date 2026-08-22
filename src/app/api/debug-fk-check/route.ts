// Route di debug TEMPORANEA — sola lettura, verifica FK/riferimenti esterni
// prima della cancellazione dati Stroili (STEP 3).
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { data: stores } = await supabaseAdmin.from('stores').select('id, nome')
  const stroili = (stores ?? []).find((s: any) => (s.nome ?? '').trim() === 'Stroili Oasi Lanciano')
  if (!stroili) return NextResponse.json({ error: 'Stroili store not found' }, { status: 404 })
  const storeId = stroili.id

  const { data: employees } = await supabaseAdmin.from('employees').select('id').eq('store_id', storeId)
  const employeeIds = (employees ?? []).map((e: any) => e.id)
  const { data: schedules } = await supabaseAdmin.from('schedules').select('id').eq('store_id', storeId)
  const scheduleIds = (schedules ?? []).map((s: any) => s.id)

  const results: any = {}

  // Tabelle store-scoped — riferimenti diretti a store_id
  for (const table of ['turni_festivi', 'turni_alternanza', 'turni_config']) {
    try {
      const { count, error } = await supabaseAdmin.from(table).select('*', { count: 'exact', head: true }).eq('store_id', storeId)
      results[table] = error ? `errore: ${error.message}` : (count ?? 0)
    } catch (e: any) {
      results[table] = `tabella non trovata o errore: ${e?.message}`
    }
  }

  // ferie_saldo — riferimento a employee_id (non store_id diretto)
  if (employeeIds.length > 0) {
    const { count, error } = await supabaseAdmin.from('ferie_saldo').select('*', { count: 'exact', head: true }).in('employee_id', employeeIds)
    results['ferie_saldo (via employee_id)'] = error ? `errore: ${error.message}` : (count ?? 0)
  } else {
    results['ferie_saldo (via employee_id)'] = 0
  }

  // Qualunque altra tabella con schedule_id che potremmo aver dimenticato
  if (scheduleIds.length > 0) {
    for (const table of ['unavailabilities', 'shifts']) {
      const { count, error } = await supabaseAdmin.from(table).select('*', { count: 'exact', head: true }).in('schedule_id', scheduleIds)
      results[`${table} (via schedule_id, gia' contate nell'inventario)`] = error ? `errore: ${error.message}` : (count ?? 0)
    }
  }

  return NextResponse.json({ store_id: storeId, employee_ids_count: employeeIds.length, schedule_ids_count: scheduleIds.length, riferimenti_trovati: results })
}
