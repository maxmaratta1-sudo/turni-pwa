// src/app/api/maia-chat/route.ts
// Proxy server-side per la chat "Maia — Turni Manager", con tool calling per
// modificare i turni direttamente da Supabase.
// La chiave ANTHROPIC_API_KEY resta SEMPRE lato server — mai esposta al client
// (una chiamata diretta dal browser richiederebbe NEXT_PUBLIC_..., che pubblica
// la chiave nel bundle JS: inaccettabile per una API key segreta).
import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { supabaseAdmin } from '@/lib/supabase'
import { ORARI_TURNO_MD, TurnoTipo } from '@/types'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const tools: Anthropic.Tool[] = [
  {
    name: 'update_shift',
    description: 'Modifica il turno di un dipendente in una data specifica',
    input_schema: {
      type: 'object',
      properties: {
        employee_name: { type: 'string', description: 'Nome del dipendente' },
        data: { type: 'string', description: 'Data in formato YYYY-MM-DD' },
        tipo: {
          type: 'string',
          enum: ['mattina', 'pomeriggio', 'full', 'riposo', 'domenica_lungo', 'domenica_corto', 'yuri_full', 'yuri_pomeriggio', 'mattina_corta', 'pomeriggio_corto'],
          description: 'Tipo di turno. yuri_full=08-16 (Lun/Mer/Ven Yuri), yuri_pomeriggio=13-16 (Mar/Gio Yuri), mattina_corta=08-13 e pomeriggio_corto=14-19 (Max, 5h)',
        },
      },
      required: ['employee_name', 'data', 'tipo'],
    },
  },
  {
    name: 'update_shift_week',
    description: 'Modifica il turno di un dipendente per tutta una settimana o più giorni consecutivi',
    input_schema: {
      type: 'object',
      properties: {
        employee_name: { type: 'string' },
        data_inizio: { type: 'string', description: 'Data inizio YYYY-MM-DD' },
        data_fine: { type: 'string', description: 'Data fine YYYY-MM-DD' },
        tipo: {
          type: 'string',
          enum: ['mattina', 'pomeriggio', 'full', 'riposo', 'domenica_lungo', 'domenica_corto', 'yuri_full', 'yuri_pomeriggio', 'mattina_corta', 'pomeriggio_corto'],
        },
      },
      required: ['employee_name', 'data_inizio', 'data_fine', 'tipo'],
    },
  },
  {
    name: 'get_employee_shifts',
    description: 'Recupera i turni di un dipendente per il mese corrente',
    input_schema: {
      type: 'object',
      properties: {
        employee_name: { type: 'string' },
      },
      required: ['employee_name'],
    },
  },
]

interface ToolCtx {
  storeId: string
  scheduleId: string
}

async function findEmployee(nome: string, storeId: string) {
  const { data, error } = await supabaseAdmin
    .from('employees')
    .select('id, nome')
    .eq('store_id', storeId)
    .ilike('nome', nome)
    .maybeSingle()
  if (error || !data) return null
  return data
}

async function upsertShift(scheduleId: string, employeeId: string, data: string, tipo: TurnoTipo) {
  const orario = tipo !== 'riposo' ? ORARI_TURNO_MD[tipo] : null
  return supabaseAdmin.from('shifts').upsert(
    {
      schedule_id: scheduleId,
      employee_id: employeeId,
      data,
      tipo,
      ora_inizio: orario?.inizio ?? null,
      ora_fine: orario?.fine ?? null,
    },
    { onConflict: 'schedule_id,employee_id,data' }
  )
}

function eachDate(start: string, end: string): string[] {
  const dates: string[] = []
  const d = new Date(start + 'T00:00:00')
  const last = new Date(end + 'T00:00:00')
  while (d <= last) {
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    dates.push(`${yyyy}-${mm}-${dd}`)
    d.setDate(d.getDate() + 1)
  }
  return dates
}

async function executeTool(toolName: string, input: any, ctx: ToolCtx): Promise<string> {
  if (toolName === 'update_shift') {
    const emp = await findEmployee(input.employee_name, ctx.storeId)
    if (!emp) return `Errore: dipendente "${input.employee_name}" non trovato.`
    const { error } = await upsertShift(ctx.scheduleId, emp.id, input.data, input.tipo)
    if (error) return `Errore salvataggio turno: ${error.message}`
    return `OK: turno di ${emp.nome} il ${input.data} impostato su "${input.tipo}".`
  }

  if (toolName === 'update_shift_week') {
    const emp = await findEmployee(input.employee_name, ctx.storeId)
    if (!emp) return `Errore: dipendente "${input.employee_name}" non trovato.`
    const dates = eachDate(input.data_inizio, input.data_fine)
    const isDomenicaTipo = input.tipo === 'domenica_lungo' || input.tipo === 'domenica_corto'
    let modificati = 0
    let saltati = 0
    for (const d of dates) {
      const dayOfWeek = new Date(d + 'T00:00:00').getDay()
      if (dayOfWeek === 0 && !isDomenicaTipo) { saltati++; continue }
      const { error } = await upsertShift(ctx.scheduleId, emp.id, d, input.tipo)
      if (!error) modificati++
    }
    return `OK: turno di ${emp.nome} impostato su "${input.tipo}" per ${modificati} giorni (${input.data_inizio} → ${input.data_fine})${saltati > 0 ? `, ${saltati} domeniche escluse` : ''}.`
  }

  if (toolName === 'get_employee_shifts') {
    const emp = await findEmployee(input.employee_name, ctx.storeId)
    if (!emp) return `Errore: dipendente "${input.employee_name}" non trovato.`
    const { data: shifts, error } = await supabaseAdmin
      .from('shifts')
      .select('data, tipo')
      .eq('schedule_id', ctx.scheduleId)
      .eq('employee_id', emp.id)
      .order('data', { ascending: true })
    if (error) return `Errore lettura turni: ${error.message}`
    if (!shifts || shifts.length === 0) return `${emp.nome} non ha turni generati per questo mese.`
    const righe = shifts.map(s => `${s.data}: ${s.tipo}`).join('\n')
    return `Turni di ${emp.nome}:\n${righe}`
  }

  return `Errore: tool "${toolName}" non riconosciuto.`
}

export async function POST(req: NextRequest) {
  const { messages, context, mese, anno, storeId, scheduleId } = await req.json()

  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: 'messages richiesto' }, { status: 400 })
  }

  const oggi = new Date().toLocaleDateString('it-IT', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
  const dataContext = mese && anno
    ? `Oggi è ${oggi}. Il mese corrente per la pianificazione turni è ${mese}/${anno}.`
    : `Oggi è ${oggi}.`

  const system = `Sei Maia, assistente AI per la gestione turni di MD Lanciano (supermercato).

${dataContext}

${context ?? ''}

REGOLE ASSOLUTE (non modificabili salvo ordine esplicito di Giacomo):
1. Gilda e Tony: sempre mattina 08-14, mai domenica
2. Yuri: Lun/Mer/Ven 08-16 in sala (turno yuri_full); Mar/Gio 13-16 in sala (turno yuri_pomeriggio, mattina in salumeria); Sab 08-14; Dom riposo
3. Carlo: Mar e Gio obbligatoriamente mattina; altri giorni preferenza mattina, pomeriggio solo se serve bilanciare le ore
4. Max: sempre 5h — mattina_corta 08-13 o pomeriggio_corto 14-19; alterna con Romeo a settimane alterne (turni standard da 6h per Romeo)
5. Cassiere 22h (Marilena, Angelica, Elisa, Damiana): 2 di mattina + 2 di pomeriggio ogni giorno
6. Fascia 13-16: sempre Yuri presente + minimo 1 altro cassiere
7. Chiusura 20:00: minimo 3 persone (sabato 4)
8. Cristina e Stefania: 3 mattine + 3 pomeriggi a settimana ciascuna (Lun/Mer/Ven mattina, Mar/Gio/Sab pomeriggio)

REGOLE DOMENICA (gestite SOLO da Giacomo — Maia non le applica automaticamente):
- Il supermercato è aperto 08:00–13:00
- Lavorano 3 persone: 2 dalle 08:00 alle 13:00 (5h, turno domenica_lungo), 1 dalle 10:00 alle 13:00 (3h, turno domenica_corto)
- Qualsiasi dipendente può lavorare la domenica (nessuna eccezione automatica — l'algoritmo di generazione automatica NON assegna mai turni domenicali, sono sempre riposo di default finché Giacomo non li assegna manualmente)
- Chi lavora domenica riceve un riposo compensativo durante la settimana pari alle ore domenicali.
  Es: lavora 08-13 domenica (5h) → riposa il giorno della settimana in cui avrebbe fatto 5h
- SOLO Giacomo è autorizzato a chiedere a Maia di inserire turni domenicali
- Se qualcun altro chiedesse di modificare turni domenicali, Maia deve rispondere:
  "Solo Giacomo è autorizzato a gestire i turni domenicali."
- Quando Giacomo assegna turni domenicali, Maia deve automaticamente proporre anche il riposo compensativo.
  Es: "Ho assegnato Cristina domenica 08-13. Vuoi che le assegni il riposo compensativo di 5h? Se sì, dimmi quale giorno."

COMPORTAMENTO:
- Rispondi sempre in italiano, sii concisa e pratica
- Puoi modificare i turni usando i tool a disposizione — se ti chiedono una modifica, USA il tool invece di limitarti a descriverla, altrimenti non viene salvata davvero
- Se una modifica richiesta viola una regola assoluta, AVVISA e chiedi conferma esplicita a Giacomo prima di procedere
- Se Giacomo conferma esplicitamente di voler procedere comunque, esegui la modifica anche in deroga alle regole`

  const canUseTools = !!storeId && !!scheduleId

  try {
    const anthropicMessages: Anthropic.MessageParam[] = messages.map((m: { role: 'user' | 'assistant'; content: string }) => ({
      role: m.role,
      content: m.content,
    }))

    let response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system,
      messages: anthropicMessages,
      ...(canUseTools ? { tools } : {}),
    })

    let toolUsed = false

    // Loop finché Claude continua a chiedere tool_use (max 5 iterazioni di sicurezza)
    for (let i = 0; i < 5 && response.stop_reason === 'tool_use'; i++) {
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use') as Anthropic.ToolUseBlock[]

      anthropicMessages.push({ role: 'assistant', content: response.content })

      const toolResults: Anthropic.ToolResultBlockParam[] = []
      for (const block of toolUseBlocks) {
        toolUsed = true
        const result = await executeTool(block.name, block.input, { storeId, scheduleId })
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
      }
      anthropicMessages.push({ role: 'user', content: toolResults })

      response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system,
        messages: anthropicMessages,
        ...(canUseTools ? { tools } : {}),
      })
    }

    const textBlock = response.content.find(b => b.type === 'text')
    const reply = textBlock && textBlock.type === 'text' ? textBlock.text : ''

    return NextResponse.json({ reply, shiftsUpdated: toolUsed })
  } catch (err: any) {
    console.error('[maia-chat] Anthropic error:', err)
    return NextResponse.json({ error: err?.message ?? 'Errore chiamata Maia' }, { status: 500 })
  }
}
