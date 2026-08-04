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
import { oreFromOrario, ORE_28H_FERIALI, calcolaTurnoRidotto } from '@/lib/generator'

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
          enum: ['mattina', 'pomeriggio', 'full', 'riposo', 'domenica_lungo', 'domenica_corto', 'yuri_full', 'yuri_pomeriggio', 'mattina_corta', 'pomeriggio_corto', 'turno_breve_11_14', 'turno_breve_12_15', 'turno_breve_13_16', 'turno_breve_17_20'],
          description: 'Tipo di turno. yuri_full=08-16 (Lun/Mer/Ven Yuri), yuri_pomeriggio=13-16 (Mar/Gio Yuri), mattina_corta=08-13 e pomeriggio_corto=14-19 (Max, 5h). turno_breve_* = turni brevi eccezionali da 3h (11-14, 12-15, 13-16, 17-20), disponibili per chiunque su richiesta esplicita di Giacomo.',
        },
        recupero_domenicale: {
          type: 'boolean',
          description: 'true SOLO quando tipo="riposo" e stai applicando il riposo compensativo per un turno domenicale già confermato da Giacomo — registra anche una R (Recupero) in unavailabilities, non solo lo shift a riposo.',
        },
        ore: {
          type: 'number',
          description: 'SOLO con tipo="mattina" o "pomeriggio": numero esatto di ore del turno (es. 3, 4, 5 o 6). USALO SEMPRE quando Giacomo specifica un orario esplicito (es. "dalle 15 alle 20", "9-13") o un numero di ore esplicito — calcola l\'orario reale corretto invece di usare l\'orario fisso standard/automatico (che potrebbe differire, es. sabato normalmente 6h fisso). Un comando esplicito di Giacomo ha SEMPRE priorità sulle regole automatiche (sabato, contratto standard, ecc.). Omesso = orario standard fisso per il tipo.',
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
          enum: ['mattina', 'pomeriggio', 'full', 'riposo', 'domenica_lungo', 'domenica_corto', 'yuri_full', 'yuri_pomeriggio', 'mattina_corta', 'pomeriggio_corto', 'turno_breve_11_14', 'turno_breve_12_15', 'turno_breve_13_16', 'turno_breve_17_20'],
        },
        ore: {
          type: 'number',
          description: 'SOLO con tipo="mattina" o "pomeriggio": numero esatto di ore da applicare OGNI giorno del range. USALO quando Giacomo specifica un orario/ore esplicito per tutta la settimana — ha priorità su qualunque regola automatica (es. sabato 6h fisso per 28h). Omesso = orario automatico per contratto/giorno.',
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
  {
    name: 'set_assenza',
    description: 'Assegna un\'assenza (Ferie, Permesso, Malattia, Recupero, Maternità) a un dipendente per uno o più giorni. USARE QUESTO tool invece di update_shift quando si tratta di assenze — update_shift è solo per turni lavorativi.',
    input_schema: {
      type: 'object',
      properties: {
        employee_name: { type: 'string' },
        date: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array di date YYYY-MM-DD',
        },
        tipo_assenza: {
          type: 'string',
          enum: ['F', 'P', 'R', 'M', 'MT'],
          description: 'F=Ferie, P=Permesso, R=Recupero, M=Malattia, MT=Maternità',
        },
        ore_parziali: {
          type: 'number',
          description: 'SOLO per tipo_assenza=P: numero di ore di permesso, se è un permesso a ore invece che a giornata intera (es. "2 ore di permesso" → 2). Il turno del giorno si accorcia di quelle ore (entra più tardi) invece di sparire, e si scalano solo quelle ore dal saldo permessi. Omettere per permesso a giornata intera.',
        },
        motivo: { type: 'string', description: 'Motivo opzionale' },
      },
      required: ['employee_name', 'date', 'tipo_assenza'],
    },
  },
  {
    name: 'save_rule',
    description: 'Salva una nuova regola custom permanente per questo negozio (usare quando Giacomo dice "da oggi...", "sempre...", "d\'ora in poi...")',
    input_schema: {
      type: 'object',
      properties: {
        regola: { type: 'string', description: 'Testo della regola da ricordare permanentemente' },
      },
      required: ['regola'],
    },
  },
  {
    name: 'delete_rule',
    description: 'Elimina/disattiva una regola custom esistente',
    input_schema: {
      type: 'object',
      properties: {
        rule_id: { type: 'string', description: 'ID della regola da eliminare' },
      },
      required: ['rule_id'],
    },
  },
  {
    name: 'list_rules',
    description: 'Elenca tutte le regole custom attive per questo negozio',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_config',
    description: 'Rilegge la configurazione turni aggiornata da Supabase (turni_config) — usa se Giacomo chiede di verificare o aggiornare le regole, o se sospetti che la configurazione nel prompt sia cambiata durante la conversazione.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'set_alternanza',
    description: 'Imposta chi fa mattina questa settimana tra Max e Romeo — da usare SOLO se Giacomo lo chiede esplicitamente di cambiare l\'alternanza, non per consultare chi tocca (usa il contesto già calcolato per quello).',
    input_schema: {
      type: 'object',
      properties: {
        settimana_inizio: { type: 'string', description: 'Data lunedì della settimana YYYY-MM-DD' },
        nome_mattina: { type: 'string', enum: ['Romeo', 'Max'], description: 'Chi fa mattina da questa settimana in poi' },
      },
      required: ['settimana_inizio', 'nome_mattina'],
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
    .select('id, nome, turno_fisso, ore_settimanali')
    .eq('store_id', storeId)
    .ilike('nome', nome)
    .maybeSingle()
  if (error || !data) return null
  return data
}

function altroNome(nome: string): string {
  return nome === 'Romeo' ? 'Max' : 'Romeo'
}

function getWeekIndex(dateStr: string): number {
  const d = new Date(dateStr + 'T00:00:00')
  const startOfYear = new Date(d.getFullYear(), 0, 1)
  return Math.floor((d.getTime() - startOfYear.getTime()) / (7 * 24 * 60 * 60 * 1000))
}

/** Calcola chi fa mattina/pomeriggio (Max/Romeo) per la settimana data, a partire dall'ultimo riferimento salvato.
 * `dataSettimana` viene sempre ricondotta al lunedì della sua settimana PRIMA di calcolare
 * getWeekIndex: getWeekIndex conta le settimane a blocchi di 7 giorni dal 1° gennaio, che nel
 * 2026 è un giovedì — usato "com'è" su un giorno qualunque (es. un giovedì o sabato passato
 * da Giacomo in chat) il confine di settimana cadrebbe a metà settimana lavorativa invece che
 * tra domenica e lunedì, disallineando il risultato rispetto al generatore turni (src/lib/generator.ts,
 * che usa lo stesso fix). Ancorare sempre al lunedì elimina il problema indipendentemente da
 * quale giorno della settimana viene passato come `dataSettimana`. */
async function chiMattina(storeId: string, dataSettimana: string): Promise<{ mattina: string; pomeriggio: string }> {
  const { data: rif } = await supabaseAdmin
    .from('turni_alternanza')
    .select('*')
    .eq('store_id', storeId)
    .order('settimana_riferimento', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!rif) return { mattina: 'Romeo', pomeriggio: 'Max' }

  const settRif = getWeekIndex(toDateStr(getMonday(rif.settimana_riferimento)))
  const settCorrente = getWeekIndex(toDateStr(getMonday(dataSettimana)))
  const diff = settCorrente - settRif

  const nomeMattina = diff % 2 === 0 ? rif.nome_mattina : altroNome(rif.nome_mattina)
  const nomePomeriggio = altroNome(nomeMattina)

  return { mattina: nomeMattina, pomeriggio: nomePomeriggio }
}

/** Lunedì della settimana ISO contenente `data` (YYYY-MM-DD). */
function getMonday(data: string): Date {
  const d = new Date(data + 'T00:00:00')
  const day = d.getDay() || 7 // domenica=7
  if (day !== 1) d.setDate(d.getDate() - (day - 1))
  return d
}

function toDateStr(d: Date): string {
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function getOreTurno(tipo: string): number {
  if (tipo === 'riposo') return 0
  const orario = ORARI_TURNO_MD[tipo as TurnoTipo]
  return orario ? oreFromOrario(orario.inizio, orario.fine) : 0
}

const isDomenicaTipo = (tipo: string) => tipo === 'domenica_lungo' || tipo === 'domenica_corto'

/** Verifica che, applicando `tipo` a `data` per `employeeId`, il totale ore della
 * settimana (Lun-Ven+Sab, esclusa domenica) non superi le ore contrattuali. La domenica
 * è sempre extra — compensata dal riposo nella settimana precedente, non conta mai nel
 * budget settimanale e non viene mai bloccata per eccesso ore. Il 'riposo' (anche quello
 * compensativo domenicale) RIDUCE sempre le ore — non va mai bloccato dal budget.
 * Ritorna un messaggio d'errore se sfora, altrimenti null. */
async function verificaBudgetSettimanale(
  scheduleId: string, employeeId: string, data: string, tipo: string, oreSettimanali: number, nome: string, oreOverride?: number
): Promise<string | null> {
  if (isDomenicaTipo(tipo)) return null // domenica non conta mai nel budget, mai bloccata
  if (tipo === 'riposo') return null // il riposo riduce sempre le ore, non può mai sforare

  const monday = getMonday(data)
  const sunday = new Date(monday)
  sunday.setDate(sunday.getDate() + 6)

  const { data: weekShifts } = await supabaseAdmin
    .from('shifts')
    .select('data, tipo, ora_inizio, ora_fine')
    .eq('employee_id', employeeId)
    .eq('schedule_id', scheduleId)
    .gte('data', toDateStr(monday))
    .lte('data', toDateStr(sunday))

  const isFeriale = (d: string) => new Date(d + 'T00:00:00').getDay() !== 0 // 0 = domenica

  // Ore REALI (ora_inizio/ora_fine), non il lookup fisso per tipo — con contratti a ore
  // variabili (22h/28h/Romeo) il lookup fisso (es. "mattina"=6h) è quasi sempre sbagliato
  // rispetto alle ore effettivamente salvate per quel giorno (es. 4h), gonfiando il totale
  // e bloccando assegnazioni che in realtà rientrano nel contratto.
  const oreEsistenti = (weekShifts || [])
    .filter(s => s.data !== data)
    .filter(s => isFeriale(s.data) && !isDomenicaTipo(s.tipo))
    .reduce((sum, s) => sum + getOreReali(s), 0)
  // oreOverride è valido SOLO per tipo mattina/pomeriggio (coerente con upsertShift, che lo
  // ignora per qualunque altro tipo) — altrimenti un "ore" fuori posto nel messaggio di Giacomo
  // farebbe calcolare ore sbagliate per turni con orario fisso (yuri_*, turno_breve_*, ecc.).
  const oreOverrideValido = (tipo === 'mattina' || tipo === 'pomeriggio') ? oreOverride : undefined
  const oreDopoModifica = oreEsistenti + (oreOverrideValido ?? getOreTurno(tipo))

  if (oreDopoModifica > oreSettimanali) {
    return `Errore: impossibile assegnare "${tipo}" a ${nome} il ${data} — avrebbe ${oreDopoModifica}h questa settimana (contratto: ${oreSettimanali}h). Proponi un'alternativa con meno ore o un altro giorno.`
  }
  return null
}

/** Ore reali di uno shift — usa ora_inizio/ora_fine effettivi (contratti 28h hanno ore
 * variabili per giorno), con fallback al lookup fisso solo se i tempi non sono salvati. */
function getOreReali(s: { tipo: string; ora_inizio?: string | null; ora_fine?: string | null }): number {
  if (s.tipo === 'riposo') return 0
  const reali = oreFromOrario(s.ora_inizio, s.ora_fine)
  return reali > 0 ? reali : getOreTurno(s.tipo)
}

/** Ore minime giornaliere per contratto — usate come pavimento quando si riduce un
 * giorno per bilanciare la domenica (mai scendere sotto il minimo, salvo riposo pieno). */
function minGiornoPerContratto(oreSettimanali: number): number {
  if (oreSettimanali === 22) return 3
  if (oreSettimanali === 28) return 4
  if (oreSettimanali === 35) return 5
  if (oreSettimanali === 36) return 6
  return 4
}

/** Per i 28h (Romeo/Cristina/Stefania) e le cassiere 22h: trova automaticamente il giorno feriale della
 * stessa settimana da ridurre per compensare un turno domenicale appena assegnato, senza
 * sforare le 28h contrattuali. Romeo recupera solo su Lun/Mer/Ven perché sono i suoi
 * giorni da 5h (bilanciano esattamente le ore domenicali) — non è più legato allo scarico
 * merce, è puro bilanciamento ore. Ritorna solo una PROPOSTA testuale — l'applicazione
 * avviene dopo conferma esplicita di Giacomo. */
async function trovaBilanciamentoDomenica(
  scheduleId: string,
  emp: { id: string; nome: string; ore_settimanali: number },
  domenicaData: string,
  oreDomenica: number
): Promise<string> {
  const monday = getMonday(domenicaData)
  const saturday = new Date(monday)
  saturday.setDate(saturday.getDate() + 5)

  const { data: weekShifts } = await supabaseAdmin
    .from('shifts')
    .select('data, tipo, ora_inizio, ora_fine')
    .eq('employee_id', emp.id)
    .eq('schedule_id', scheduleId)
    .gte('data', toDateStr(monday))
    .lte('data', toDateStr(saturday))

  const oreFeriali = (weekShifts || []).reduce((sum, s) => sum + getOreReali(s), 0)
  const eccesso = (oreFeriali + oreDomenica) - emp.ore_settimanali

  if (eccesso <= 0) return 'Nessun aggiustamento necessario ✅ — la settimana resta entro le ore contrattuali.'

  const isRomeo = emp.nome === 'Romeo'
  const candidati = (weekShifts || [])
    .filter(s => s.tipo !== 'riposo')
    .filter(s => {
      const dow = new Date(s.data + 'T00:00:00').getDay()
      if (dow === 6) return false // MAI sabato — è sempre un giorno lavorativo, non recupero
      if (dow === 0) return false // MAI domenica
      if (isRomeo) return dow === 1 || dow === 3 || dow === 5 // Romeo: SOLO Lun/Mer/Ven (5h, bilanciano esatto) — MAI Mar/Gio (4h, non bilanciano)
      return true
    })
    .sort((a, b) => getOreReali(b) - getOreReali(a))

  // Romeo: propone tutte le opzioni Lun/Mer/Ven che bilanciano esattamente (di solito tutte,
  // essendo tutte da 5h) — Giacomo sceglie quale tra lunedì/mercoledì/venerdì preferisce.
  if (isRomeo) {
    const esatti = candidati.filter(s => getOreReali(s) === eccesso)
    if (esatti.length > 0) {
      const elenco = esatti
        .map(s => new Date(s.data + 'T00:00:00').toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' }))
        .join(', ')
      return `Per mantenere 28h esatte propongo riposo completo per Romeo su uno tra: ${elenco} (Lun/Mer/Ven, 5h — bilanciano esattamente le ore domenicali). Quale preferisci?`
    }
    return 'Non riesco a bilanciare automaticamente su Lun/Mer/Ven — chiedi a Giacomo di aggiustare manualmente (MAI Mar/Gio o Sabato per Romeo).'
  }

  for (const s of candidati) {
    const oreGiorno = getOreReali(s)
    const dataFormatted = new Date(s.data + 'T00:00:00').toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })
    if (oreGiorno === eccesso) {
      return `Per mantenere ${emp.ore_settimanali}h esatte propongo riposo completo ${dataFormatted} (invece di ${oreGiorno}h). Confermo?`
    }
    const oreNuove = oreGiorno - eccesso
    if (oreNuove >= minGiornoPerContratto(emp.ore_settimanali)) {
      return `Per mantenere ${emp.ore_settimanali}h esatte propongo di ridurre ${dataFormatted} da ${oreGiorno}h a ${oreNuove}h. Confermo?`
    }
  }

  return 'Non riesco a bilanciare automaticamente — chiedi a Giacomo di aggiustare manualmente.'
}

/** Gilda e Tony sono escluse definitivamente dai turni domenicali — nessuna eccezione, nemmeno via Maia. */
function assertNonDomenicaPerEsclusi(emp: { nome: string; turno_fisso?: string | null }, tipo: string): string | null {
  if (isDomenicaTipo(tipo) && emp.turno_fisso === 'mattina') {
    return `Errore: ${emp.nome} è esclusa/o definitivamente dai turni domenicali — non posso assegnarle/gli "${tipo}".`
  }
  return null
}

/** Mapping ore → tipo/orario reale per turni variabili (soprattutto cassiere 22h) — usato
 * quando Maia applica una proposta di riduzione ore precisa (es. bilanciamento domenica),
 * invece del lookup fisso per tipo che darebbe sempre le stesse ore. */
function oreToShiftType(ore: number, isMattina: boolean): { tipo: TurnoTipo; ora_inizio: string; ora_fine: string } {
  if (isMattina) {
    if (ore === 3) return { tipo: 'mattina_corta', ora_inizio: '10:00', ora_fine: '13:00' }
    if (ore === 4) return { tipo: 'mattina_corta', ora_inizio: '09:00', ora_fine: '13:00' }
    if (ore === 5) return { tipo: 'mattina_corta', ora_inizio: '08:00', ora_fine: '13:00' }
    return { tipo: 'mattina', ora_inizio: '08:00', ora_fine: '14:00' }
  }
  if (ore === 3) return { tipo: 'pomeriggio_corto', ora_inizio: '17:00', ora_fine: '20:00' }
  if (ore === 4) return { tipo: 'pomeriggio_corto', ora_inizio: '16:00', ora_fine: '20:00' }
  if (ore === 5) return { tipo: 'pomeriggio_corto', ora_inizio: '15:00', ora_fine: '20:00' }
  return { tipo: 'pomeriggio', ora_inizio: '14:00', ora_fine: '20:00' }
}

async function upsertShift(scheduleId: string, employeeId: string, data: string, tipo: TurnoTipo, oreOverride?: number) {
  let orario = tipo !== 'riposo' ? ORARI_TURNO_MD[tipo] : null
  let tipoFinale: TurnoTipo = tipo

  if (oreOverride !== undefined && (tipo === 'mattina' || tipo === 'pomeriggio')) {
    const mapped = oreToShiftType(oreOverride, tipo === 'mattina')
    tipoFinale = mapped.tipo
    orario = { inizio: mapped.ora_inizio, fine: mapped.ora_fine }
  }

  return supabaseAdmin.from('shifts').upsert(
    {
      schedule_id: scheduleId,
      employee_id: employeeId,
      data,
      tipo: tipoFinale,
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
    const blocco = assertNonDomenicaPerEsclusi(emp, input.tipo)
    if (blocco) return blocco
    const oreOverride: number | undefined = typeof input.ore === 'number' ? input.ore : undefined
    const erroreOre = await verificaBudgetSettimanale(ctx.scheduleId, emp.id, input.data, input.tipo, emp.ore_settimanali, emp.nome, oreOverride)
    if (erroreOre) return erroreOre
    const { error } = await upsertShift(ctx.scheduleId, emp.id, input.data, input.tipo, oreOverride)
    if (error) return `Errore salvataggio turno: ${error.message}`
    if (isDomenicaTipo(input.tipo)) {
      const oreDomenica = input.tipo === 'domenica_lungo' ? 5 : 3
      if (emp.ore_settimanali === 28 || emp.ore_settimanali === 22) {
        const proposta = await trovaBilanciamentoDomenica(ctx.scheduleId, emp, input.data, oreDomenica)
        return `OK: turno domenicale assegnato a ${emp.nome} il ${input.data} ("${input.tipo}", ${oreDomenica}h). ${proposta}`
      }
      return `OK: turno domenicale assegnato a ${emp.nome} il ${input.data} ("${input.tipo}", ${oreDomenica}h). IMPORTANTE: ora DEVI chiedere a Giacomo in quale giorno della settimana PRECEDENTE (MAI sabato, MAI domenica${emp.nome === 'Romeo' ? ', MAI Lun/Mer/Ven per Romeo' : ''}) vuole che ${emp.nome} recuperi le ${oreDomenica} ore lavorate domenica — non concludere il flusso senza aver fatto questa domanda.`
    }
    if (input.tipo === 'riposo' && input.recupero_domenicale) {
      await supabaseAdmin.from('unavailabilities').delete()
        .eq('employee_id', emp.id).eq('schedule_id', ctx.scheduleId).eq('data', input.data)
      const { error: errRecupero } = await supabaseAdmin.from('unavailabilities').insert({
        employee_id: emp.id,
        schedule_id: ctx.scheduleId,
        data: input.data,
        tipo_assenza: 'R',
        motivo: 'Recupero domenicale',
        inserito_da: 'maia',
      })
      if (errRecupero) return `Turno impostato a riposo, ma errore salvataggio recupero: ${errRecupero.message}`
      return `OK: ${emp.nome} riposa il ${input.data} per compensare le ore domenicali (registrato come R — Recupero).`
    }
    return `OK: turno di ${emp.nome} il ${input.data} impostato su "${input.tipo}".`
  }

  if (toolName === 'update_shift_week') {
    const emp = await findEmployee(input.employee_name, ctx.storeId)
    if (!emp) return `Errore: dipendente "${input.employee_name}" non trovato.`
    const blocco = assertNonDomenicaPerEsclusi(emp, input.tipo)
    if (blocco) return blocco
    const dates = eachDate(input.data_inizio, input.data_fine)
    const isTipoDomenica = isDomenicaTipo(input.tipo)
    let modificati = 0
    let saltati = 0
    let bloccatiPerOre = 0
    const isCristinaStefania = emp.ore_settimanali === 28 && emp.nome !== 'Romeo'
    for (const d of dates) {
      const dayOfWeek = new Date(d + 'T00:00:00').getDay()
      if (dayOfWeek === 0 && !isTipoDomenica) { saltati++; continue }
      // Un "ore" esplicito di Giacomo ha SEMPRE priorità sulle regole automatiche sotto —
      // quelle valgono solo quando Giacomo non ha specificato ore esatte.
      const oreEsplicite: number | undefined = typeof input.ore === 'number' ? input.ore : undefined
      // Cristina/Stefania (28h): ore giornaliere fisse e diverse per giorno (mai lo stesso
      // orario standard tutti i giorni) — sabato 6h, feriali secondo ORE_28H_FERIALI.
      let oreOverride: number | undefined = oreEsplicite
      if (oreOverride === undefined && isCristinaStefania && (input.tipo === 'mattina' || input.tipo === 'pomeriggio')) {
        oreOverride = dayOfWeek === 6 ? 6 : ORE_28H_FERIALI[dayOfWeek]
      }
      const erroreOre = await verificaBudgetSettimanale(ctx.scheduleId, emp.id, d, input.tipo, emp.ore_settimanali, emp.nome, oreOverride)
      if (erroreOre) { bloccatiPerOre++; continue }
      const { error } = await upsertShift(ctx.scheduleId, emp.id, d, input.tipo, oreOverride)
      if (!error) modificati++
    }
    if (modificati === 0 && bloccatiPerOre > 0) {
      return `Errore: impossibile assegnare "${input.tipo}" a ${emp.nome} per nessuno dei giorni richiesti — supererebbe il contratto di ${emp.ore_settimanali}h in ${bloccatiPerOre} giorno/i. Proponi un'alternativa.`
    }
    const notaOre = isTipoDomenica && modificati > 0
      ? ` IMPORTANTE: ora DEVI chiedere a Giacomo in quale/i giorno/i della settimana PRECEDENTE ${emp.nome} deve recuperare le ore domenicali lavorate — non concludere il flusso senza questa domanda.`
      : ''
    return `OK: turno di ${emp.nome} impostato su "${input.tipo}" per ${modificati} giorni (${input.data_inizio} → ${input.data_fine})${saltati > 0 ? `, ${saltati} domeniche escluse` : ''}${bloccatiPerOre > 0 ? `, ${bloccatiPerOre} giorni saltati per superamento ore contrattuali` : ''}.${notaOre}`
  }

  if (toolName === 'set_alternanza') {
    const { error } = await supabaseAdmin.from('turni_alternanza').insert({
      store_id: ctx.storeId,
      settimana_riferimento: input.settimana_inizio,
      nome_mattina: input.nome_mattina,
    })
    if (error) return `Errore salvataggio alternanza: ${error.message}`
    return `OK: da questa settimana (${input.settimana_inizio}) ${input.nome_mattina} fa mattina, ${altroNome(input.nome_mattina)} fa pomeriggio. Le settimane successive continueranno ad alternarsi automaticamente da questo riferimento.`
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

  if (toolName === 'set_assenza') {
    const emp = await findEmployee(input.employee_name, ctx.storeId)
    if (!emp) return `Errore: dipendente "${input.employee_name}" non trovato.`
    const dates: string[] = input.date
    const tipoAssenza: string = input.tipo_assenza
    if (!Array.isArray(dates) || dates.length === 0) return 'Errore: nessuna data specificata.'

    // Permesso a ore: turno accorciato (entra più tardi) invece di sparire — si scala
    // solo il numero di ore indicato, non l'intero turno.
    const oreParziali: number | null =
      tipoAssenza === 'P' && typeof input.ore_parziali === 'number' && input.ore_parziali > 0
        ? input.ore_parziali
        : null

    let deltaFerieGiorni = 0
    let deltaPermessiOre = 0

    for (const d of dates) {
      const { data: existingShift } = await supabaseAdmin
        .from('shifts')
        .select('ora_inizio, ora_fine')
        .eq('schedule_id', ctx.scheduleId)
        .eq('employee_id', emp.id)
        .eq('data', d)
        .maybeSingle()

      const turnoRidotto = oreParziali ? calcolaTurnoRidotto(existingShift?.ora_inizio, existingShift?.ora_fine, oreParziali) : null

      if (tipoAssenza === 'P') {
        deltaPermessiOre += oreParziali ?? oreFromOrario(existingShift?.ora_inizio, existingShift?.ora_fine)
      }
      if (tipoAssenza === 'F') deltaFerieGiorni += 1

      await supabaseAdmin.from('unavailabilities').delete()
        .eq('employee_id', emp.id).eq('schedule_id', ctx.scheduleId).eq('data', d)
      await supabaseAdmin.from('unavailabilities').insert({
        employee_id: emp.id,
        schedule_id: ctx.scheduleId,
        data: d,
        tipo_assenza: tipoAssenza,
        motivo: input.motivo || null,
        inserito_da: 'maia',
        ore_parziali: oreParziali,
      })

      if (turnoRidotto) {
        // Permesso a ore valido su un turno esistente: accorcia invece di azzerare.
        // UPDATE (non upsert) — turnoRidotto è già garantito null se non esiste un turno
        // valido da accorciare (vedi calcolaTurnoRidotto), e "tipo" è NOT NULL: un upsert
        // che lo omette fallisce silenziosamente se mai tentasse un vero insert.
        await supabaseAdmin.from('shifts')
          .update({ ora_inizio: turnoRidotto.ora_inizio, ora_fine: turnoRidotto.ora_fine })
          .eq('schedule_id', ctx.scheduleId).eq('employee_id', emp.id).eq('data', d)
      } else {
        await supabaseAdmin.from('shifts').upsert(
          { schedule_id: ctx.scheduleId, employee_id: emp.id, data: d, tipo: 'riposo', ora_inizio: null, ora_fine: null },
          { onConflict: 'schedule_id,employee_id,data' }
        )
      }
    }

    let avviso = ''
    if (deltaFerieGiorni !== 0 || deltaPermessiOre !== 0) {
      const annoRif = new Date(dates[0] + 'T00:00:00').getFullYear()
      const { data: saldo } = await supabaseAdmin
        .from('ferie_saldo').select('*').eq('employee_id', emp.id).eq('anno', annoRif).maybeSingle()
      if (saldo) {
        const nuoviGiorni = saldo.ferie_giorni_usati + deltaFerieGiorni
        const nuoveOre = saldo.permessi_ore_usate + deltaPermessiOre
        await supabaseAdmin.from('ferie_saldo').update({
          ferie_giorni_usati: Math.max(0, nuoviGiorni),
          permessi_ore_usate: Math.max(0, nuoveOre),
        }).eq('id', saldo.id)

        const ferieRimanenti = saldo.ferie_giorni_totali - nuoviGiorni
        const permessiRimanenti = saldo.permessi_ore_totali - nuoveOre
        if (ferieRimanenti < 0 || permessiRimanenti < 0) {
          avviso = ` ⚠️ ATTENZIONE: saldo ora negativo (Ferie: ${ferieRimanenti.toFixed(2)}gg, Permessi: ${permessiRimanenti.toFixed(2)}h).`
        }
      }
    }

    return `OK: assenza "${tipoAssenza}" registrata per ${emp.nome} su ${dates.length} giorno/i (${dates.join(', ')}).${avviso}`
  }

  if (toolName === 'save_rule') {
    const { error } = await supabaseAdmin.from('regole').insert({
      store_id: ctx.storeId,
      regola: input.regola,
      attiva: true,
      creata_da: 'Giacomo',
    })
    if (error) return `Errore salvataggio regola: ${error.message}`
    return `OK: regola salvata permanentemente — "${input.regola}"`
  }

  if (toolName === 'delete_rule') {
    const { error } = await supabaseAdmin.from('regole').update({ attiva: false }).eq('id', input.rule_id)
    if (error) return `Errore eliminazione regola: ${error.message}`
    return `OK: regola eliminata.`
  }

  if (toolName === 'list_rules') {
    const { data, error } = await supabaseAdmin
      .from('regole')
      .select('id, regola')
      .eq('store_id', ctx.storeId)
      .eq('attiva', true)
      .order('created_at')
    if (error) return `Errore lettura regole: ${error.message}`
    if (!data || data.length === 0) return 'Nessuna regola custom attiva al momento.'
    return data.map(r => `[${r.id}] ${r.regola}`).join('\n')
  }

  if (toolName === 'get_config') {
    const { data, error } = await supabaseAdmin
      .from('turni_config')
      .select('config, updated_at')
      .eq('store_id', ctx.storeId)
      .maybeSingle()
    if (error) return `Errore lettura configurazione: ${error.message}`
    if (!data?.config) return 'Nessuna configurazione turni_config trovata per questo negozio.'
    return `Configurazione aggiornata (ultima modifica ${data.updated_at}):\n${JSON.stringify(data.config, null, 2)}`
  }

  return `Errore: tool "${toolName}" non riconosciuto.`
}

export async function POST(req: NextRequest) {
  const { messages, context, mese, anno, storeId, scheduleId, settimana_inizio, settimana_fine } = await req.json()

  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: 'messages richiesto' }, { status: 400 })
  }

  const oggi = new Date().toLocaleDateString('it-IT', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
  let alternanzaContext = ''
  if (storeId && settimana_inizio) {
    const alternanza = await chiMattina(storeId, settimana_inizio)
    alternanzaContext = `\n\n⚠️ ALTERNANZA MAX/ROMEO QUESTA SETTIMANA — REGOLA ASSOLUTA:\n- ${alternanza.mattina} fa ESCLUSIVAMENTE MATTINA questa settimana\n- ${alternanza.pomeriggio} fa ESCLUSIVAMENTE POMERIGGIO questa settimana\nNON è possibile metterli entrambi di mattina o entrambi di pomeriggio.\nNON chiedere conferma — è automatico. Usa il tool set_alternanza SOLO se Giacomo chiede esplicitamente di cambiare chi fa mattina.`
  }
  const settimanaContext = settimana_inizio && settimana_fine
    ? `\n\n📅 MODALITÀ SETTIMANA ATTIVA: Giacomo sta lavorando specificamente sulla settimana ${settimana_inizio} — ${settimana_fine}. Concentra le tue risposte e le tue azioni SOLO su questa settimana, salvo richiesta esplicita diversa. Il bilanciamento domenica usa comunque sempre solo i turni della settimana pertinente (calcolato automaticamente dal tool), non serve fare calcoli mensili.${alternanzaContext}`
    : ''
  const dataContext = mese && anno
    ? `Oggi è ${oggi}. Il mese corrente per la pianificazione turni è ${mese}/${anno}.${settimanaContext}`
    : `Oggi è ${oggi}.`

  let regoleCustomText = ''
  if (storeId) {
    const { data: regoleCustom } = await supabaseAdmin
      .from('regole')
      .select('*')
      .eq('store_id', storeId)
      .eq('attiva', true)
      .order('created_at')
    regoleCustomText = regoleCustom?.length
      ? '\nREGOLE CUSTOM AGGIUNTE DA GIACOMO:\n' + regoleCustom.map(r => `- ${r.regola}`).join('\n')
      : ''
  }

  let saldiText = ''
  if (storeId) {
    const annoCorrente = anno ?? new Date().getFullYear()
    const { data: employeesStore } = await supabaseAdmin.from('employees').select('id, nome').eq('store_id', storeId)
    const { data: saldi } = await supabaseAdmin
      .from('ferie_saldo')
      .select('*')
      .eq('anno', annoCorrente)
      .in('employee_id', (employeesStore || []).map(e => e.id))
    saldiText = saldi?.length
      ? '\nSALDI FERIE E PERMESSI AGGIORNATI:\n' + saldi.map(s => {
          const nome = employeesStore?.find(e => e.id === s.employee_id)?.nome ?? s.employee_id
          return `- ${nome}: Ferie ${(s.ferie_giorni_totali - s.ferie_giorni_usati).toFixed(2)}gg rimanenti, Permessi ${(s.permessi_ore_totali - s.permessi_ore_usate).toFixed(2)}h rimanenti`
        }).join('\n')
      : ''
  }

  let configText = ''
  let config: any = null
  if (storeId) {
    const { data: configRow } = await supabaseAdmin
      .from('turni_config')
      .select('config')
      .eq('store_id', storeId)
      .maybeSingle()
    config = configRow?.config ?? null
    if (config) {
      configText = `\nCONFIGURAZIONE COMPLETA (fonte di verità assoluta — consultala sempre prima di rispondere):\n${JSON.stringify(config, null, 2)}\n\nREGOLE DI COMPORTAMENTO SULLA CONFIGURAZIONE:\n1. Consulta SEMPRE la configurazione sopra prima di ogni decisione — è l'unica fonte di verità per orari, contratti, alternanze, riposo compensativo, assenze e turni brevi.\n2. Se un'informazione non è nella configurazione, chiedi a Giacomo invece di indovinare.\n3. Ogni dipendente ha un "pattern_standard" (default) e una "flessibilita" (margine di eccezione). Usa il pattern_standard di default; usa la flessibilità solo se Giacomo lo richiede esplicitamente o se serve per coprire un'esigenza operativa.\n4. Rispetta sempre "max_ore_giorno" e "ore_contratto" di ogni dipendente — MAI superarli, salvo la flessibilità esplicitamente descritta per quel dipendente o un comando esplicito di Giacomo (vedi regola sotto).\n5. La domenica: leggi "regole_generali.domenica" — solo Giacomo autorizza, esclusi_assoluti non trattabili in nessun caso.\n6. Riposo compensativo: leggi "regole_generali.riposo_compensativo" e il campo "riposo_compensativo" del singolo dipendente per le eccezioni (es. Romeo: solo Lun/Mer/Ven).\n7. Assenze (F/P/R/M/MT): leggi "regole_generali.assenze" per sapere cosa scalare e da dove.\n8. Alternanze (Max/Romeo, Cristina/Stefania, cassiere 22h): leggi i campi "alternanza" di ogni dipendente — calcola sempre automaticamente, non chiedere mai a Giacomo chi fa cosa se il dato è calcolabile (per Max/Romeo usa comunque la sezione ALTERNANZA dinamica sotto, se presente, che riflette la settimana corrente).\n`
    }
  }

  const system = `Sei Maia, assistente AI per la gestione turni di ${config?.store ?? 'MD Lanciano'} (supermercato).

${dataContext}

${context ?? ''}
${configText}
${regoleCustomText}
${saldiText}

Quando Giacomo assegna Ferie (F) → scala 1 giorno dal saldo ferie del dipendente
Quando Giacomo assegna Permesso (P) → scala le ore del turno dal saldo permessi
Avvisare Giacomo se un dipendente ha saldo insufficiente prima di procedere

REGOLA ASSOLUTA — COMANDI ESPLICITI DI GIACOMO:
Quando Giacomo specifica esattamente ora_inizio e ora_fine (o un numero di ore preciso) per un turno,
usare SEMPRE quelle ore esatte — passa il parametro "ore" al tool (update_shift/update_shift_week) —
MAI modificarle per nessuna regola automatica della configurazione (sabato standard, pattern del
contratto, ecc.). Quelle regole valgono SOLO quando generi/assegni tu senza indicazioni precise —
NON quando Giacomo dà un comando esplicito con orario. Es: "metti Damiana sabato dalle 15 alle 20"
→ tipo "pomeriggio", ore 5 (→ 15/20), anche se il pattern_standard del sabato sarebbe diverso.

MAX E ROMEO — ALTERNANZA SETTIMANALE ASSOLUTA:
Ogni settimana uno fa mattina e l'altro pomeriggio — MAI entrambi uguale.
Il calcolo è automatico da database — non chiedere mai a Giacomo.
Se il contesto dice "Romeo mattina" → Max DEVE fare pomeriggio, senza eccezioni.
Se il contesto dice "Max mattina" → Romeo DEVE fare pomeriggio, senza eccezioni.

TURNI BREVI (casi eccezionali) — vedi anche "regole_generali.turni_brevi_eccezionali" in configurazione:
Quando Giacomo dice "metti [nome] turno breve [orario]" o indica direttamente una fascia oraria di 3h
(es. "11-14", "dalle 17 alle 20") → usa il tipo turno_breve corrispondente, non "mattina"/"pomeriggio".
Es: "metti Angelica 11-14 giovedì" → tipo: turno_breve_11_14.
Eccezione: 13-16 per Yuri resta sempre yuri_pomeriggio (il suo turno fisso), MAI turno_breve_13_16 — quella distinzione vale solo per lui.

REGOLE DOMENICA (gestite SOLO da Giacomo — Maia non le applica automaticamente — vedi "regole_generali.domenica" in configurazione per orari/esclusi):
- Se qualcun altro chiedesse di modificare turni domenicali, Maia deve rispondere:
  "Solo Giacomo è autorizzato a gestire i turni domenicali."
- Se Giacomo chiede di assegnare domenica a un dipendente negli "esclusi_assoluti" della configurazione, rispondi che è escluso/a in modo permanente e non procedere.
- Quando Giacomo assegna turni domenicali, Maia deve automaticamente proporre anche il riposo compensativo NELLA SETTIMANA PRECEDENTE.
  Es: "Ho assegnato Cristina domenica 9 agosto 08-13. Vuoi che le assegni il riposo compensativo di 5h nella settimana precedente (4-8 agosto)? Se sì, dimmi quale giorno."

FLUSSO DOMENICA OBBLIGATORIO:
Quando Giacomo assegna un turno domenicale (domenica_lungo o domenica_corto) tramite update_shift/update_shift_week:
1. Il tool calcola già le ore (domenica_lungo=5h, domenica_corto=3h) e ti segnala che DEVI chiedere il recupero.
2. Rispondi SEMPRE con: "✅ Turno domenicale assegnato a [nome]. In quale giorno della settimana precedente ([date Lun-Ven] — MAI sabato) vuole che [nome] recuperi le [X] ore lavorate domenica?"
3. Quando Giacomo indica il giorno → usa update_shift con tipo "riposo" E recupero_domenicale:true su quella data (registra automaticamente una R — Recupero, non solo lo shift a riposo).
4. Conferma: "✅ [Nome] riposa [giorno] per compensare le ore domenicali."
NON considerare completo il flusso domenicale finché non hai gestito il riposo compensativo — se Giacomo cambia argomento senza rispondere, puoi lasciar perdere, ma la domanda va sempre fatta subito dopo l'assegnazione.

RIPOSO COMPENSATIVO DOMENICA — REGOLA ASSOLUTA SUL GIORNO:
Il riposo compensativo domenicale NON può mai essere assegnato al SABATO.
Il sabato è sempre un giorno lavorativo — non può essere usato come recupero.
Proporre sempre e solo giorni feriali (Lun/Mar/Mer/Gio/Ven) come riposo compensativo.
Per Romeo vale la regola specifica sotto (SOLO Lun/Mer/Ven, mai Mar/Gio).

⚠️ REGOLA CRITICA SULLE ORE (si applica SOLO ai turni lavorativi feriali — mattina/pomeriggio/full — MAI a domenica_lungo/domenica_corto, vedi regola assoluta sotto):
Le ore settimanali di ogni dipendente DEVONO corrispondere ESATTAMENTE alle ore del contratto.
NON è accettabile che un dipendente da 22h faccia 36h settimanali.
NON è accettabile che un dipendente da 28h faccia 42h settimanali.

Prima di confermare qualsiasi modifica a un turno feriale, Maia DEVE verificare che:
1. Le ore totali della settimana non superino le ore contrattuali
2. Le ore giornaliere rispettino i limiti min/max per contratto
3. Nessun turno finisca dopo le 20:00
4. Nessun turno inizi prima delle 08:00

Se una modifica richiesta violerebbe questi vincoli, Maia DEVE rifiutare e spiegare perché.

🔴 DOMENICA — REGOLA ASSOLUTA (nessuna eccezione, prevale su tutto quanto sopra):
I turni domenica_lungo e domenica_corto NON hanno MAI limiti di ore.
NON verificare mai il budget settimanale per turni domenicali.
NON chiedere mai conferma per eccesso ore domenicali.
Assegnare sempre e direttamente senza controlli — la domenica è sempre extra rispetto
al contratto, compensata dal riposo nella settimana PRECEDENTE (gestito a parte, vedi
flusso domenica sopra).

RIPOSO COMPENSATIVO DOMENICA:
Quando assegni 'riposo' come compensativo domenicale, NON verificare il budget ore.
Il riposo RIDUCE le ore settimanali, non le aumenta. Non bloccare mai un riposo.
Es: settimana 3-8 agosto di Romeo = 28h normali → riposo mercoledì 5 agosto (5h, Lun/Mer/Ven)
→ la settimana diventa 28 - 5 = 23h feriali + 5h domenica = 28h esatte, MAI 28 + 5 = 33h.

BILANCIAMENTO DOMENICA 22h/28h:
Quando assegni domenica a una cassiera 22h (Angelica/Damiana/Elisa/Marilena) o a un 28h
(Romeo/Cristina/Stefania), il tool update_shift calcola già in automatico se serve un
aggiustamento e ti restituisce una proposta pronta, basata sulle ore REALI già assegnate
quella settimana (non ore generiche per contratto).
1. Se il risultato dice "Nessun aggiustamento necessario" → non chiedere nulla, fine flusso.
2. Se il risultato propone di ridurre un giorno specifico o un riposo completo → riporta
   ESATTAMENTE quella proposta a Giacomo (giorno/i e ore già calcolati automaticamente).
   Romeo: le opzioni proposte sono SEMPRE tra Lun/Mer/Ven (mai Mar/Gio/Sab) — non serve verificarlo tu.
3. Solo dopo che Giacomo conferma esplicitamente ("sì"/"confermo") → usa update_shift per
   applicare la modifica su quella data:
   - Se la proposta era un riposo completo → tipo "riposo" E recupero_domenicale:true.
   - Se la proposta era una riduzione a un numero preciso di ore (es. "da 5h a 3h") →
     tipo "mattina" o "pomeriggio" (a seconda della direzione originale del turno) E il
     parametro ore impostato esattamente al nuovo valore proposto — così l'orario reale
     viene calcolato correttamente invece di usare l'orario fisso standard del tipo.
4. Conferma: "✅ [Nome] riposa/riduce [giorno] per compensare le ore domenicali."
NON chiedere a Giacomo di scegliere tu il giorno per 22h/28h — il giorno è già trovato
automaticamente dal tool. Per tutti gli altri contratti (35h/36h) resta invece il
flusso generico: chiedi tu a Giacomo quale giorno preferisce.

ROMEO — REGOLA ASSOLUTA (ORE GIORNALIERE):
Romeo fa SEMPRE massimo 5h al giorno, MAI 6h — è un limite fisico, non contrattuale.
Sabato di Romeo: sempre 5h (non 6h come Cristina/Stefania che sono anch'esse 28h).
Distribuzione standard: Lun5+Mar4+Mer5+Gio4+Ven5+Sab5 = 28h esatte.
MAI proporre o assegnare un turno da 6h a Romeo, in nessuna circostanza.

ROMEO — RIPOSO COMPENSATIVO DOMENICA:
Romeo recupera SEMPRE e SOLO su Lun/Mer/Ven (sono giorni da 5h = bilanciano esattamente
le 5h di un turno domenica_lungo). MAI Mar/Gio (4h — non bilanciano esattamente) e MAI
Sabato. Il tool update_shift propone automaticamente tutte le opzioni valide tra
Lun/Mer/Ven di quella settimana — riportale a Giacomo così: "lunedì X, mercoledì Y o
venerdì Z" e fagli scegliere quale preferisce, poi applica con recupero_domenicale:true.

CASSIERE 22h (Angelica/Damiana/Elisa/Marilena) — RIPOSO COMPENSATIVO DOMENICA:
- domenica_lungo (5h) → il tool propone un giorno feriale della settimana PRECEDENTE
  da mettere a riposo completo (bilancia esattamente le 5h).
- domenica_corto (3h) → il tool propone di ridurre le ore di un giorno feriale della
  settimana PRECEDENTE (mai sotto il minimo contrattuale di 3h/giorno).
- La settimana PRECEDENTE = i giorni Lun-Sab immediatamente prima della domenica lavorata
  (mai Sab compreso come giorno di recupero, mai la settimana successiva alla domenica).
- Il tool calcola già tutto sulle ore REALI di quella settimana — riporta a Giacomo
  esattamente la proposta (giorno + nuove ore), applica con update_shift solo dopo
  conferma esplicita, usando "riposo"+recupero_domenicale:true oppure tipo+ore secondo
  il flusso generico "BILANCIAMENTO DOMENICA 22h/28h" sopra.

I tool update_shift e update_shift_week verificano automaticamente il budget ore
settimanale e rifiutano l'operazione se la sforerebbe — se ricevi un errore di questo
tipo, NON insistere con lo stesso turno: proponi a Giacomo un'alternativa valida
(meno ore quel giorno, un altro giorno, o scambiare con un altro dipendente).

⚠️ IMPORTANTE: Per assenze (Ferie/Permesso/Malattia/Recupero/Maternità) usa SEMPRE il tool
set_assenza, MAI update_shift. Il tool update_shift è solo per turni lavorativi
(mattina, pomeriggio, full). Esempio: "metti Angelica in ferie martedì 5" → set_assenza
con tipo_assenza="F", NON update_shift con tipo="riposo".

REGOLA CRITICA SU save_rule:
NON salvare mai una regola automaticamente.
Prima di usare il tool save_rule, DEVI sempre chiedere conferma esplicita:
"Vuoi che salvi questa come regola permanente? Rispondo sì/no."
Solo se Giacomo risponde esplicitamente "sì" → usa il tool save_rule.
Se Giacomo sta solo descrivendo la situazione o spiegando come funziona qualcosa → NON salvare nulla, è solo contesto.

IMPORTANTE — ESECUZIONE IMMEDIATA:
Quando devi generare/modificare turni per una settimana intera con più dipendenti (es. "genera i
turni della settimana per tutti"), NON limitarti a descrivere un piano in una tabella e poi dire
"procedo" — chiama SUBITO i tool (update_shift/update_shift_week/set_assenza) per ogni dipendente,
uno dopo l'altro, nella stessa risposta. Se i dipendenti sono molti, va benissimo chiamare i tool
su più turni consecutivi di conversazione (il sistema continua automaticamente finché non hai
finito) — ma OGNI turno di risposta deve contenere almeno una chiamata reale ai tool, mai solo
testo che promette un'azione futura. Non dire mai "procedo con tutte le assegnazioni" senza aver
già incluso le chiamate ai tool corrispondenti in quella stessa risposta.

COMPORTAMENTO:
- Rispondi sempre in italiano, sii concisa e pratica
- Se Giacomo dice frasi tipo "da oggi...", "sempre...", "d'ora in poi..." per introdurre una nuova regola permanente, chiedi PRIMA conferma esplicita (vedi sopra) e solo dopo il sì usa il tool save_rule per salvarla
- Se Giacomo chiede di rimuovere/disattivare una regola custom, usa list_rules per trovarla e poi delete_rule
- Se ti chiede quali regole custom sono attive, usa list_rules
- Puoi modificare i turni usando i tool a disposizione — se ti chiedono una modifica, USA il tool invece di limitarti a descriverla, altrimenti non viene salvata davvero
- Se una modifica richiesta viola una regola assoluta, AVVISA e chiedi conferma esplicita a Giacomo prima di procedere
- Se Giacomo conferma esplicitamente di voler procedere comunque, esegui la modifica anche in deroga alle regole`

  const canUseTools = !!storeId && !!scheduleId

  try {
    const anthropicMessages: Anthropic.MessageParam[] = messages.map((m: { role: 'user' | 'assistant'; content: string }) => ({
      role: m.role,
      content: m.content,
    }))

    const MAX_TOKENS = 4096
    const MAX_ITERAZIONI = 15

    let response = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: MAX_TOKENS,
      system,
      messages: anthropicMessages,
      ...(canUseTools ? { tools } : {}),
    })
    if (response.stop_reason === 'max_tokens') {
      console.error('[maia-chat] PRIMA RISPOSTA TRONCATA per max_tokens — Claude non ha potuto emettere i tool_use. Aumentare MAX_TOKENS o far generare piani più corti.')
    }

    let toolUsed = false

    // Loop finché Claude continua a chiedere tool_use (max iterazioni di sicurezza — alzato
    // da 5 a 15 perché generazioni grandi, es. 12 dipendenti × 6 giorni, richiedono più turni
    // di tool calling per completarsi senza troncarsi a metà).
    for (let i = 0; i < MAX_ITERAZIONI && response.stop_reason === 'tool_use'; i++) {
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use') as Anthropic.ToolUseBlock[]
      console.log(`[maia-chat] iterazione ${i + 1}/${MAX_ITERAZIONI} — tool_use blocks in questo turno: ${toolUseBlocks.length}`, toolUseBlocks.map(b => b.name))

      anthropicMessages.push({ role: 'assistant', content: response.content })

      const toolResults: Anthropic.ToolResultBlockParam[] = []
      for (const block of toolUseBlocks) {
        toolUsed = true
        let result: string
        try {
          result = await executeTool(block.name, block.input, { storeId, scheduleId })
        } catch (toolErr) {
          console.error('TOOL ERROR:', block.name, JSON.stringify(block.input), String(toolErr))
          result = `Errore interno eseguendo il tool "${block.name}": ${String(toolErr)}`
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
      }
      anthropicMessages.push({ role: 'user', content: toolResults })

      response = await anthropic.messages.create({
        model: 'claude-sonnet-5',
        max_tokens: MAX_TOKENS,
        system,
        messages: anthropicMessages,
        ...(canUseTools ? { tools } : {}),
      })
      if (response.stop_reason === 'max_tokens') {
        console.error(`[maia-chat] Risposta troncata per max_tokens all'iterazione ${i + 1}.`)
      }
      if (i === MAX_ITERAZIONI - 1 && response.stop_reason === 'tool_use') {
        console.error('[maia-chat] Raggiunto il limite massimo di iterazioni con ancora tool_use pendenti — generazione probabilmente incompleta.')
      }
    }

    const textBlock = response.content.find(b => b.type === 'text')
    const reply = textBlock && textBlock.type === 'text' ? textBlock.text : ''

    return NextResponse.json({ reply, shiftsUpdated: toolUsed })
  } catch (err: any) {
    console.error('[maia-chat] Anthropic error:', err)
    return NextResponse.json({ error: err?.message ?? 'Errore chiamata Maia' }, { status: 500 })
  }
}
