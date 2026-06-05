import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '내 마음을 읽는 타로',
  description: 'A reflective tarot reading experience.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0 }}>{children}</body>
    </html>
  );
}
