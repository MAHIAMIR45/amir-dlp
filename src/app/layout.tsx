import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "YT Downloader · Media Downloader",
  description:
    "Download YouTube & TikTok videos and audio. Search YouTube or paste a YouTube/TikTok link — download quickly with audio.",
  keywords: ["YouTube downloader", "TikTok downloader", "video downloader", "audio downloader"],
  authors: [{ name: "Mian Amir" }],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body style={{ margin: 0, padding: 0 }}>{children}</body>
    </html>
  );
}
