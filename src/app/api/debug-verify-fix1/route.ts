import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// Route di debug TEMPORANEA — verifica FIX 1 (Opzione 2) con dati reali: modifica una
// cella, chiama il vero endpoint /api/shifts/generate, verifica che la modifica sia
// sopravvissuta. Rimuovere subito dopo l'uso.
const TOKEN = 'volt-verify-fix1-20092026'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  if (searchParams.get('token') !== TOKEN) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const action = searchParams.get('action') ?? 'pick'

  if (action === 'pick') {
    const { data: shifts, error } = await supabaseAdmin
      .from('shifts').select('*').order('data', { ascending: false }).limit(3)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ shifts })
  }

  if (action === 'test') {
    const shiftId = searchParams.get('shift_id')
    if (!shiftId) return NextResponse.json({ error: 'shift_id required' }, { status: 400 })

    const { data: originale, error: err1 } = await supabaseAdmin.from('shifts').select('*').eq('id', shiftId).single()
    if (err1 || !originale) return NextResponse.json({ error: `lettura originale fallita: ${err1?.message}` }, { status: 500 })

    // Modifica distintiva
    const { error: err2 } = await supabaseAdmin.from('shifts').update({ ora_fine: '08:37' }).eq('id', shiftId)
    if (err2) return NextResponse.json({ error: `update fallito: ${err2.message}` }, { status: 500 })

    // Chiama il VERO endpoint /api/shifts/generate (simula il click "Genera turni")
    const baseUrl = new URL(req.url).origin
    const genRes = await fetch(`${baseUrl}/api/shifts/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule_id: originale.schedule_id }),
    })
    const genBody = await genRes.json()

    // Rilegge la cella modificata
    const { data: dopo } = await supabaseAdmin.from('shifts').select('*').eq('id', shiftId).single()

    return NextResponse.json({
      originale,
      genRes: { status: genRes.status, body: genBody },
      dopoGenerazione: dopo,
      modifica_sopravvissuta: dopo?.ora_fine === '08:37:00',
    })
  }

  if (action === 'restore') {
    const shiftId = searchParams.get('shift_id')
    const ora_fine = searchParams.get('ora_fine')
    if (!shiftId || !ora_fine) return NextResponse.json({ error: 'shift_id, ora_fine required' }, { status: 400 })
    const { error } = await supabaseAdmin.from('shifts').update({ ora_fine }).eq('id', shiftId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}
