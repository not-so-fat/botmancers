import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Botmancers",
  description: "Cloud-hosted AI teammate app",
  icons: {
    icon: [
      { url: "/brand/botmancers-logo-filled-64.png", sizes: "64x64", type: "image/png" },
      { url: "/brand/botmancers-logo-filled-256.png", sizes: "256x256", type: "image/png" },
    ],
    apple: [
      { url: "/brand/botmancers-logo-filled-256.png", sizes: "256x256", type: "image/png" },
    ],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
