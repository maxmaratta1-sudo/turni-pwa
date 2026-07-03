import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Turni',
  description: 'Gestione turni dipendenti',
  manifest: '/manifest.json',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="it">
      <body>{children}</body>
    </html>
  )
}
