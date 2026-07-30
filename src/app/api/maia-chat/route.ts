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
import { oreFromOrario } from '@/lib/generator'

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
        recupero_domenicale: {
          type: 'boolean',
          description: 'true SOLO quando tipo="riposo" e stai applicando il riposo compensativo per un turno domenicale già confermato da Giacomo — registra anche una R (Recupero) in unavailabilities, non solo lo shift a riposo.',
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
  scheduleId: string, employeeId: string, data: string, tipo: string, oreSettimanali: number, nome: string
): Promise<string | null> {
  if (isDomenicaTipo(tipo)) return null // domenica non conta mai nel budget, mai bloccata
  if (tipo === 'riposo') return null // il riposo riduce sempre le ore, non può mai sforare

  const monday = getMonday(data)
  const sunday = new Date(monday)
  sunday.setDate(sunday.getDate() + 6)

  const { data: weekShifts } = await supabaseAdmin
    .from('shifts')
    .select('data, tipo')
    .eq('employee_id', employeeId)
    .eq('schedule_id', scheduleId)
    .gte('data', toDateStr(monday))
    .lte('data', toDateStr(sunday))

  const isFeriale = (d: string) => new Date(d + 'T00:00:00').getDay() !== 0 // 0 = domenica

  const oreEsistenti = (weekShifts || [])
    .filter(s => s.data !== data)
    .filter(s => isFeriale(s.data) && !isDomenicaTipo(s.tipo))
    .reduce((sum, s) => sum + getOreTurno(s.tipo), 0)
  const oreDopoModifica = oreEsistenti + getOreTurno(tipo)

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

/** Per i 28h (Romeo/Cristina/Stefania): trova automaticamente il giorno feriale della
 * stessa settimana da ridurre per compensare un turno domenicale appena assegnato, senza
 * sforare le 28h contrattuali. Romeo (scarico merce) non tocca mai Lun/Mer/Ven. Ritorna
 * solo una PROPOSTA testuale — l'applicazione avviene dopo conferma esplicita di Giacomo. */
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
    if (oreNuove >= 4) {
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
    const blocco = assertNonDomenicaPerEsclusi(emp, input.tipo)
    if (blocco) return blocco
    const erroreOre = await verificaBudgetSettimanale(ctx.scheduleId, emp.id, input.data, input.tipo, emp.ore_settimanali, emp.nome)
    if (erroreOre) return erroreOre
    const { error } = await upsertShift(ctx.scheduleId, emp.id, input.data, input.tipo)
    if (error) return `Errore salvataggio turno: ${error.message}`
    if (isDomenicaTipo(input.tipo)) {
      const oreDomenica = input.tipo === 'domenica_lungo' ? 5 : 3
      if (emp.ore_settimanali === 28) {
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
    for (const d of dates) {
      const dayOfWeek = new Date(d + 'T00:00:00').getDay()
      if (dayOfWeek === 0 && !isTipoDomenica) { saltati++; continue }
      const erroreOre = await verificaBudgetSettimanale(ctx.scheduleId, emp.id, d, input.tipo, emp.ore_settimanali, emp.nome)
      if (erroreOre) { bloccatiPerOre++; continue }
      const { error } = await upsertShift(ctx.scheduleId, emp.id, d, input.tipo)
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

      if (tipoAssenza === 'P') {
        deltaPermessiOre += oreFromOrario(existingShift?.ora_inizio, existingShift?.ora_fine)
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
      })

      await supabaseAdmin.from('shifts').upsert(
        { schedule_id: ctx.scheduleId, employee_id: emp.id, data: d, tipo: 'riposo', ora_inizio: null, ora_fine: null },
        { onConflict: 'schedule_id,employee_id,data' }
      )
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

  const system = `Sei Maia, assistente AI per la gestione turni di MD Lanciano (supermercato).

${dataContext}

${context ?? ''}

VINCOLI ORARI NEGOZIO:
- Apertura: 08:00 — Chiusura: 20:00
- Nessun turno può iniziare prima delle 08:00 o finire dopo le 20:00
- Turni pomeridiani: fine sempre 20:00, inizio = 20:00 - ore del turno
  Es: 4h pomeriggio → 16/20 | 5h → 15/20 | 6h → 14/20
- Mai iniziare un turno pomeridiano oltre le 17:00

ORE GIORNALIERE PER CONTRATTO:
- 22h: min 3h/giorno, max 5h/giorno — sabato sempre 5h (8/13)
- 28h: min 4h/giorno, max 6h/giorno — sabato sempre 6h
- 35h: min 5h/giorno, max 6h/giorno — sabato sempre 6h
- 30h (Max): sempre 5h fisso — mattina 8/13, pomeriggio 14/19 — alterna con Romeo
- 36h: sempre 6h/giorno — sabato 6h

CASSIERE 22h — ORARIO INIZIO MATTINA FLESSIBILE:
- Possono iniziare alle 08:00, 09:00 o 10:00
- Fine = inizio + ore assegnate
- La scelta dipende dalla copertura necessaria
${regoleCustomText}
${saldiText}

Quando Giacomo assegna Ferie (F) → scala 1 giorno dal saldo ferie del dipendente
Quando Giacomo assegna Permesso (P) → scala le ore del turno dal saldo permessi
Avvisare Giacomo se un dipendente ha saldo insufficiente prima di procedere

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
- ECCEZIONE ASSOLUTA: Gilda e Tony sono escluse DEFINITIVAMENTE dai turni domenicali, senza eccezioni — nemmeno su richiesta esplicita di Giacomo. Se te lo chiedesse, rispondi: "Gilda e Tony sono escluse in modo permanente dai turni domenicali — non posso assegnarle/gli la domenica."
- Tutti gli altri dipendenti possono lavorare la domenica (nessuna eccezione automatica per loro — l'algoritmo di generazione automatica NON assegna mai turni domenicali a nessuno, sono sempre riposo di default finché Giacomo non li assegna manualmente)
- Chi lavora domenica riceve un riposo compensativo nella settimana PRECEDENTE la domenica lavorata (non quella successiva), pari alle ore domenicali.
  Es: lavora domenica 9 agosto (08-13, 5h) → il riposo compensativo va nella settimana 4-8 agosto (la settimana che precede il 9), nel giorno in cui avrebbe fatto 5h
- SOLO Giacomo è autorizzato a chiedere a Maia di inserire turni domenicali
- Se qualcun altro chiedesse di modificare turni domenicali, Maia deve rispondere:
  "Solo Giacomo è autorizzato a gestire i turni domenicali."
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

BILANCIAMENTO DOMENICA 28h:
Quando assegni domenica a Romeo/Cristina/Stefania (28h), il tool update_shift calcola
già in automatico se serve un aggiustamento e ti restituisce una proposta pronta.
1. Se il risultato dice "Nessun aggiustamento necessario" → non chiedere nulla, fine flusso.
2. Se il risultato propone di ridurre un giorno specifico o un riposo completo → riporta
   ESATTAMENTE quella proposta a Giacomo (giorno/i e ore già calcolati automaticamente).
   Romeo: le opzioni proposte sono SEMPRE tra Lun/Mer/Ven (mai Mar/Gio/Sab) — non serve verificarlo tu.
3. Solo dopo che Giacomo conferma esplicitamente ("sì"/"confermo") → usa update_shift con
   tipo "riposo" E recupero_domenicale:true (o le ore ridotte proposte, senza il flag se
   non è un riposo completo) su quella data per applicare la modifica.
4. Conferma: "✅ [Nome] riposa/riduce [giorno] per compensare le ore domenicali."
NON chiedere a Giacomo di scegliere tu il giorno per i 28h — il giorno è già trovato
automaticamente dal tool. Per tutti gli altri contratti (22h/35h/36h) resta invece il
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
