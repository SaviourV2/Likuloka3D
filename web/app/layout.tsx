import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Likuloka 3D',
  description: 'Edit buildings, levels, walls, zones and slabs in 3D, in the browser.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#1428a0' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&family=JetBrains+Mono:wght@400;600&display=swap" />
      </head>
      <body>{children}</body>
    </html>
  );
}
