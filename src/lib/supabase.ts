import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
const service = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

if (!url) console.error('[supabase] NEXT_PUBLIC_SUPABASE_URL is missing — check Vercel env vars')
if (!anon) console.error('[supabase] NEXT_PUBLIC_SUPABASE_ANON_KEY is missing — check Vercel env vars')

export const supabase = url && anon
  ? createClient(url, anon)
  : createClient('https://placeholder.supabase.co', 'placeholder')

export const supabaseAdmin = url && service
  ? createClient(url, service)
  : createClient('https://placeholder.supabase.co', 'placeholder')
