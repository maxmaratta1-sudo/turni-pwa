import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { generateShiftsMDWeek } from '@/lib/generator'
import { generateWeekWithOpus, resolveOpusShifts } from '@/lib/generateWithOpus'
import { validateWeekShifts } from '@/lib/validateShifts'

export async function POST(req: NextRequest) {
  try {
    // Settimane a cavallo (25/08/2026): il body non passa più un `schedule_id` scalare +
    // `week_start`/`week_end`, ma la lista dei giorni Lun-Sab della settimana con lo
    // schedule_id GIÀ RISOLTO per ciascuno (dal frontend, via ensureSchedule) — normalmente
    // tutti uguali, fino a 2 diversi per una settimana che attraversa due mesi. Vedi
    // CLAUDE.md, sezione "settimane a cavallo tra due mesi/schedule".
    const { giorni, use_opus } = await req.json() as {
      giorni?: { data: string; schedule_id: string }[]
      use_opus?: boolean
    }

    if (!giorni || giorni.length === 0) {
      return NextResponse.json({ error: 'giorni (array di {data, schedule_id}) required' }, { status: 400 })
    }

    const weekStart = giorni[0].data
    const weekEnd = giorni[giorni.length - 1].data
    const scheduleIds = Array.from(new Set(giorni.map(g => g.schedule_id)))

    const { data: schedules, error: scheduleErr } = await supabaseAdmin
      .from('schedules').select('*').in('id', scheduleIds)
    if (scheduleErr) console.error('[shifts/generate-week] schedule fetch error:', JSON.stringify(scheduleErr, null, 2))
    if (!schedules || schedules.length !== scheduleIds.length) {
      return NextResponse.json({ error: 'Uno o più schedule della settimana non sono stati trovati' }, { status: 404 })
    }
    const scheduleById = new Map(schedules.map(s => [s.id, s]))
    // Tutti gli schedule di una stessa settimana appartengono per costruzione allo stesso
    // negozio (un negozio ha un solo store_id) — prendiamo store_id/dipendenti dal primo.
    const storeId = schedules[0].store_id
    const scheduleIdForData = (data: string): string => {
      const g = giorni.find(x => x.data === data)
      return g?.schedule_id ?? schedules[0].id
    }

    const { data: employees, error: employeesErr } = await supabaseAdmin
      .from('employees').select('*').eq('store_id', storeId).eq('attivo', true)
    if (employeesErr) console.error('[shifts/generate-week] employees fetch error:', JSON.stringify(employeesErr, null, 2))

    // Domenica già assegnata: è weekEnd + 1 giorno (weekEnd è il sabato di questa
    // settimana) — appartiene sempre allo STESSO schedule_id del sabato che la precede
    // (una domenica non "attraversa" mai un confine di mese rispetto al proprio sabato).
    const sabato = new Date(weekEnd + 'T00:00:00')
    const domenica = new Date(sabato)
    domenica.setDate(domenica.getDate() + 1)
    const domenicaStr = domenica.toISOString().split('T')[0]
    const scheduleIdDomenica = scheduleIdForData(weekEnd)

    const { data: domenicaShifts, error: domErr } = await supabaseAdmin
      .from('shifts')
      .select('employee_id, tipo')
      .eq('schedule_id', scheduleIdDomenica)
      .eq('data', domenicaStr)
      .in('tipo', ['domenica_lungo', 'domenica_corto'])
    if (domErr) console.error('[shifts/generate-week] domenica fetch error:', JSON.stringify(domErr, null, 2))

    // Settimane a cavallo: unavailabilities/turni esistenti vanno letti per OGNI
    // schedule_id coinvolto (fino a 2), non solo uno — altrimenti i giorni dell'altro
    // mese risulterebbero sempre "senza indisponibilità" e "senza turni esistenti" anche
    // quando non è vero.
    const unavailabilities: { employee_id: string; data: string; [k: string]: unknown }[] = []
    const turniEsistenti: { employee_id: string; data: string }[] = []
    for (const schedId of scheduleIds) {
      const dateDelloSchedule = giorni.filter(g => g.schedule_id === schedId).map(g => g.data)
      const inizio = dateDelloSchedule[0]
      const fine = dateDelloSchedule[dateDelloSchedule.length - 1]

      const { data: unav, error: unavailErr } = await supabaseAdmin
        .from('unavailabilities').select('*').eq('schedule_id', schedId).gte('data', inizio).lte('data', fine)
      if (unavailErr) console.error('[shifts/generate-week] unavailabilities fetch error:', JSON.stringify(unavailErr, null, 2))
      unavailabilities.push(...(unav || []))

      // Turni Lun-Sab già esistenti in questa settimana: NON li tocchiamo (potrebbero
      // essere stati assegnati/modificati manualmente da Giacomo o da Maia) — generiamo
      // solo per gli slot dipendente/giorno ancora vuoti.
      const { data: esist, error: esistentiErr } = await supabaseAdmin
        .from('shifts').select('employee_id, data').eq('schedule_id', schedId).gte('data', inizio).lte('data', fine)
      if (esistentiErr) console.error('[shifts/generate-week] turni esistenti fetch error:', JSON.stringify(esistentiErr, null, 2))
      turniEsistenti.push(...(esist || []))
    }

    const turniManuale = new Set(turniEsistenti.map(t => `${t.employee_id}_${t.data}`))

    let shiftsGenerati: Awaited<ReturnType<typeof generateShiftsMDWeek>>
    let engine: 'opus' | 'js' = 'js'
    let opusValidationErrors: ReturnType<typeof validateWeekShifts> | null = null

    const generaConJS = () => generateShiftsMDWeek({
      giorni: giorni.map(g => ({ data: g.data, scheduleId: g.schedule_id })),
      employees: employees || [],
      unavailabilities: unavailabilities as any,
      domenicaShifts: domenicaShifts || [],
    })

    // Opus è opt-in esplicito (use_opus:true nel body) — il default resta il generatore
    // JS deterministico, per non cambiare il comportamento del bottone esistente in
    // manager/page.tsx senza una decisione esplicita di attivarlo lì.
    if (use_opus && storeId) {
      const { data: configRow, error: configErr } = await supabaseAdmin
        .from('turni_config').select('config').eq('store_id', storeId).maybeSingle()
      if (configErr || !configRow?.config) {
        return NextResponse.json({ error: `turni_config mancante per lo store — impossibile usare Opus (${configErr?.message ?? 'nessuna riga'})` }, { status: 500 })
      }

      try {
        const turniOpus = await generateWeekWithOpus({
          config: configRow.config,
          weekStart,
          weekEnd,
          domenicaShifts: domenicaShifts || [],
          unavailabilities: unavailabilities.map(u => ({ employee_id: u.employee_id, data: u.data })),
          employees: employees || [],
        })
        const resolved = resolveOpusShifts(turniOpus, scheduleIdForData, employees || [])
        const validationErrors = validateWeekShifts(resolved, employees || [], configRow.config)

        if (validationErrors.length > 0) {
          console.error('[shifts/generate-week] Opus output non valido, fallback a JS:', JSON.stringify(validationErrors, null, 2))
          opusValidationErrors = validationErrors
          shiftsGenerati = await generaConJS()
        } else {
          engine = 'opus'
          shiftsGenerati = resolved
        }
      } catch (opusErr) {
        console.error('[shifts/generate-week] Opus generation error, fallback a JS:', opusErr)
        shiftsGenerati = await generaConJS()
      }
    } else {
      shiftsGenerati = await generaConJS()
    }

    const shifts = shiftsGenerati.filter(s => !turniManuale.has(`${s.employee_id}_${s.data}`))
    const saltatiPerEsistenti = shiftsGenerati.length - shifts.length

    console.log('[shifts/generate-week] settimana:', weekStart, '→', weekEnd, '| schedule_id coinvolti:', scheduleIds.join(', '), '| engine:', engine, '| shifts da inserire:', shifts.length, '| saltati (già assegnati):', saltatiPerEsistenti)

    const { error } = await supabaseAdmin.from('shifts').insert(shifts)
    if (error) {
      console.error('[shifts/generate-week] insert error:', JSON.stringify(error, null, 2))
      return NextResponse.json({ error: error.message, details: error.details, hint: error.hint, code: error.code }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      engine,
      shifts_generated: shifts.length,
      shifts_preservati: saltatiPerEsistenti,
      opus_validation_errors: opusValidationErrors, // non-null solo se Opus è stato tentato e scartato
    })
  } catch (error) {
    console.error('SHIFTS GENERATE-WEEK ERROR:', JSON.stringify(error, null, 2))
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
