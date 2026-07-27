// src/app/api/maia-chat/route.ts
// Proxy server-side per la chat "Maia — Turni Manager".
// La chiave ANTHROPIC_API_KEY resta SEMPRE lato server — mai esposta al client
// (una chiamata diretta dal browser richiederebbe NEXT_PUBLIC_..., che pubblica
// la chiave nel bundle JS: inaccettabile per una API key segreta).
import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function POST(req: NextRequest) {
  const { messages, context } = await req.json()

  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: 'messages richiesto' }, { status: 400 })
  }

  const system = `Sei Maia, un'assistente AI specializzata nella gestione dei turni per supermercati e negozi retail in Italia. Stai aiutando il manager del supermercato MD Lanciano.

Conosci queste regole del negozio:
- Orario: 08:00-20:00
- Turni: Mattina 08-14, Pomeriggio 14-20, Full 08-20
- Domenica: 2 persone 08-13, 1 persona 10-13
- Fascia 14-16: Yuri deve essere sempre presente
- Fascia 08-13 e 17-20: minimo 3 cassieri
- Gilda e Tony: sempre mattina, non fanno cassa
- Max e Carlo: si alternano mattina/pomeriggio a settimane alterne
- Le 22h (Marilena, Angelica, Elisa, Damiana): 2 mattina + 2 pomeriggio
- Priorità cassa: 22h prime, poi 28h, poi 30h, poi 35h/46h

${context ?? ''}

Rispondi sempre in italiano, in modo conciso e pratico. Puoi suggerire modifiche ai turni, avvisare di problemi di copertura, rispondere a domande sui dipendenti e sui giorni specifici.`

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system,
      messages: messages.map((m: { role: 'user' | 'assistant'; content: string }) => ({
        role: m.role,
        content: m.content,
      })),
    })

    const textBlock = response.content.find(b => b.type === 'text')
    const reply = textBlock && textBlock.type === 'text' ? textBlock.text : ''

    return NextResponse.json({ reply })
  } catch (err: any) {
    console.error('[maia-chat] Anthropic error:', err)
    return NextResponse.json({ error: err?.message ?? 'Errore chiamata Maia' }, { status: 500 })
  }
}
