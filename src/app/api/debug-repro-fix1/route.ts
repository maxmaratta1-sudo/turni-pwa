import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// Route di debug TEMPORANEA — repro FIX 1 (20 settembre 2026, richiesta Giacomo).
// Sola indagine, nessuna modifica al comportamento reale. Rimuovere subito dopo l'uso.
const TOKEN = 'volt-repro-fix1-20092026'

function noStoreClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  return createClient(url, key, {
    global: { fetch: (u: any, opts: any) => fetch(u, { ...opts, cache: 'no-store' }) },
  })
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  if (searchParams.get('token') !== TOKEN) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const action = searchParams.get('action') ?? 'inspect'
  const supabase = noStoreClient()

  if (action === 'inspect') {
    // Trova un turno reale qualsiasi da usare per il test (non domenica/festivo, per
    // semplicità), con relativo employee/schedule per contesto.
    const { data: shifts, error } = await supabase
      .from('shifts')
      .select('*')
      .order('data', { ascending: false })
      .limit(5)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ shifts })
  }

  if (action === 'test-persistence') {
    const shiftId = searchParams.get('shift_id')
    if (!shiftId) return NextResponse.json({ error: 'shift_id required' }, { status: 400 })

    // 1. Legge il valore ORIGINALE (per poterlo ripristinare dopo)
    const { data: originale, error: err1 } = await supabase.from('shifts').select('*').eq('id', shiftId).single()
    if (err1 || !originale) return NextResponse.json({ error: `lettura originale fallita: ${err1?.message}` }, { status: 500 })

    // 2. Applica una modifica DISTINTIVA — stesso identico pattern dell'update client-side
    //    reale in manager/page.tsx (handleCellSelect): .update({tipo, ora_inizio, ora_fine, sequenza}).eq('id', ...)
    const valoreTest = { tipo: 'mattina', ora_inizio: '08:00', ora_fine: '08:37', sequenza: 1 } // 08:37 = firma inconfondibile, mai un valore reale
    const { error: err2 } = await supabase.from('shifts').update(valoreTest).eq('id', shiftId)
    if (err2) return NextResponse.json({ error: `update fallito: ${err2.message}` }, { status: 500 })

    // 3. Legge SUBITO dopo, stessa request — deve riflettere il nuovo valore
    const { data: dopoScrittura } = await supabase.from('shifts').select('*').eq('id', shiftId).single()

    // 4. Attende 3 secondi (simula il tempo che passa tra "salva" e "chiudi/riapri app"),
    //    poi legge di nuovo con una chiamata Supabase COMPLETAMENTE separata (nuovo
    //    client, stessa request però — per un vero secondo request va richiamato questo
    //    stesso endpoint con action=verify).
    await new Promise((r) => setTimeout(r, 3000))
    const supabase2 = noStoreClient()
    const { data: dopoAttesa } = await supabase2.from('shifts').select('*').eq('id', shiftId).single()

    return NextResponse.json({
      originale,
      valoreTest,
      dopoScrittura,
      dopoAttesa,
      persistito_subito: dopoScrittura?.ora_fine === '08:37',
      persistito_dopo_attesa: dopoAttesa?.ora_fine === '08:37',
    })
  }

  if (action === 'verify') {
    // Simula ESATTAMENTE la lettura che fa il browser al reload/riapertura app —
    // richiesta HTTP completamente separata da quella che ha scritto.
    const shiftId = searchParams.get('shift_id')
    if (!shiftId) return NextResponse.json({ error: 'shift_id required' }, { status: 400 })
    const { data } = await supabase.from('shifts').select('*').eq('id', shiftId).single()
    return NextResponse.json({ data, ora_fine_e_ancora_08_37: data?.ora_fine === '08:37' })
  }

  if (action === 'restore') {
    const shiftId = searchParams.get('shift_id')
    const tipo = searchParams.get('tipo')
    const ora_inizio = searchParams.get('ora_inizio')
    const ora_fine = searchParams.get('ora_fine')
    const sequenza = searchParams.get('sequenza')
    if (!shiftId || !tipo || !ora_inizio || !ora_fine) {
      return NextResponse.json({ error: 'shift_id, tipo, ora_inizio, ora_fine required' }, { status: 400 })
    }
    const { error } = await supabase.from('shifts').update({
      tipo, ora_inizio, ora_fine, sequenza: sequenza ? Number(sequenza) : 1,
    }).eq('id', shiftId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}
