import Anthropic from '@anthropic-ai/sdk'
import { Employee, Shift } from '@/types'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const OPUS_MODEL = 'claude-opus-5'

interface OpusShiftOut {
  employee_nome: string
  data: string
  tipo: string
  ora_inizio?: string
  ora_fine?: string
}

interface GenerateWeekWithOpusParams {
  config: any // turni_config completo
  weekStart: string
  weekEnd: string
  domenicaShifts: { employee_id: string; tipo: string }[]
  unavailabilities: { employee_id: string; data: string }[]
  employees: Employee[]
}

/** Genera i turni Lun-Sab di una settimana con Claude Opus, usando turni_config
 * come unica fonte di verità delle regole. Non salva nulla — ritorna solo la
 * proposta; la validazione e il salvataggio restano a carico del chiamante
 * (src/app/api/shifts/generate-week/route.ts), che deve rifiutare l'output
 * se viola un vincolo hard invece di salvarlo silenziosamente. */
export async function generateWeekWithOpus(params: GenerateWeekWithOpusParams): Promise<OpusShiftOut[]> {
  const response = await anthropic.messages.create({
    model: OPUS_MODEL,
    max_tokens: 8192,
    system: `Sei un motore di generazione turni per supermercati. Ricevi la configurazione
completa del negozio (regole, pattern per dipendente, vincoli assoluti) e devi produrre
l'assegnazione turni ottimale per la settimana richiesta (Lunedì-Sabato — la Domenica
NON va generata da te, viene sempre assegnata manualmente).

REGOLE DI RAGIONAMENTO:
1. Usa "pattern_standard" di ogni dipendente come base di default.
2. Usa "flessibilita" solo quando il pattern standard non permette di raggiungere
   esattamente "ore_contratto" per la settimana, o per coprire vincoli operativi.
3. "regola_assoluta" non si può MAI violare, in nessun caso.
4. Rispetta sempre "max_ore_giorno" per ogni dipendente.
5. Verifica sempre "copertura_chiusura" (persone con turno che finisce alle 20:00) e
   "fascia_obbligatoria_cassa" (13:00-16:00: Yuri + almeno un altro cassiere).
6. Applica "sabato_no_ripetizione": nessun dipendente applicabile può fare lo stesso
   turno (mattina o pomeriggio) del sabato precedente — se non hai lo storico del
   sabato precedente nel messaggio, usa il buon senso e documenta la scelta nel
   ragionamento, ma non bloccare la generazione.
7. Cristina e Stefania non lavorano MAI lo stesso turno lo stesso giorno — sempre opposte.
8. Ferie/permessi/assenze/domeniche già assegnate sono vincoli fissi, non modificabili:
   se un dipendente ha un'indisponibilità per una data, assegnagli "riposo" quel giorno.
9. Il totale ore settimanale di ogni dipendente (esclusa domenica, che è sempre extra)
   deve corrispondere esattamente a "ore_contratto" — non di più, non di meno, salvo
   quando un'indisponibilità riduce i giorni disponibili.

Restituisci SOLO tramite la function call "salva_turni_settimana" un array con ESATTAMENTE
una riga per ogni dipendente per ogni giorno Lun-Sab della settimana (tipo "riposo" per i
giorni non lavorati, incluse le indisponibilità).`,
    messages: [{
      role: 'user',
      content: JSON.stringify({
        config: params.config,
        settimana: { inizio: params.weekStart, fine: params.weekEnd },
        domeniche_gia_assegnate: params.domenicaShifts,
        assenze: params.unavailabilities,
        dipendenti_attivi: params.employees.map(e => ({ nome: e.nome.trim(), ore_settimanali: e.ore_settimanali })),
      }),
    }],
    tools: [{
      name: 'salva_turni_settimana',
      description: "Salva l'assegnazione turni generata per la settimana",
      input_schema: {
        type: 'object',
        properties: {
          turni: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                employee_nome: { type: 'string' },
                data: { type: 'string', description: 'YYYY-MM-DD' },
                tipo: { type: 'string' },
                ora_inizio: { type: 'string', description: 'HH:MM, assente se tipo=riposo' },
                ora_fine: { type: 'string', description: 'HH:MM, assente se tipo=riposo' },
              },
              required: ['employee_nome', 'data', 'tipo'],
            },
          },
        },
        required: ['turni'],
      },
    }],
    tool_choice: { type: 'tool', name: 'salva_turni_settimana' },
  })

  const toolUse = response.content.find((c): c is Anthropic.ToolUseBlock => c.type === 'tool_use')
  const turni = (toolUse?.input as any)?.turni
  if (!Array.isArray(turni)) {
    throw new Error('generateWeekWithOpus: risposta senza array "turni" valido — impossibile procedere')
  }
  return turni
}

/** Converte l'output di Opus (per nome dipendente) in righe Shift pronte per l'insert
 * (per employee_id), risolvendo i nomi contro l'elenco dipendenti attivi. Righe con
 * nome non riconosciuto vengono scartate con un warning — non blocchiamo l'intera
 * settimana per un singolo nome sbagliato, ma nemmeno le salviamo alla cieca. */
export function resolveOpusShifts(
  turni: OpusShiftOut[],
  scheduleId: string,
  employees: Employee[]
): Omit<Shift, 'id' | 'created_at'>[] {
  const byNome = new Map(employees.map(e => [e.nome.trim().toLowerCase(), e]))
  const result: Omit<Shift, 'id' | 'created_at'>[] = []

  for (const t of turni) {
    const emp = byNome.get((t.employee_nome ?? '').trim().toLowerCase())
    if (!emp) {
      console.warn(`[OPUS-GENERATOR] nome non riconosciuto tra i dipendenti attivi, riga scartata: ${t.employee_nome}`)
      continue
    }
    result.push({
      schedule_id: scheduleId,
      employee_id: emp.id,
      data: t.data,
      tipo: t.tipo as Shift['tipo'],
      ora_inizio: t.tipo === 'riposo' ? undefined : t.ora_inizio,
      ora_fine: t.tipo === 'riposo' ? undefined : t.ora_fine,
    })
  }
  return result
}
